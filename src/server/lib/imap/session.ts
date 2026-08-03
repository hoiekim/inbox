/* eslint-disable no-case-declarations */
import { Socket } from "net";
import { TLSSocket } from "tls";
import { readFileSync } from "fs";
import crypto from "crypto";
import { Throttler } from "common";
import { logger } from "server";
import { Store } from "./store";
import {
  FetchRequest,
  SearchRequest,
  StoreRequest,
  CopyRequest,
  MoveRequest,
  AppendRequest,
  StatusItem,
} from "./types";
import {
  idleManager,
  IDLE_SOCKET_TIMEOUT_MS,
  SOCKET_TIMEOUT_MS,
} from "./idle-manager";
import { getCapabilities } from "./capabilities";
import { ImapRequestHandler } from "./handler";
import { writeChunkedToSocket, writeStreamToSocket } from "./chunked-write";

// Extracted module helpers
import { handleAuthenticate, handleLogin } from "./auth";
import { READONLY_USERNAME } from "../postgres/initialize";
import {
  createMailbox,
  deleteMailbox,
  renameMailbox,
  subscribeMailbox,
  unsubscribeMailbox,
  statusMailbox,
  listMailboxes,
  listSubscribedMailboxes,
  selectMailbox as selectMailboxOp,
} from "./mailbox-ops";
import {
  fetchMessagesTyped as fetchMessagesOp,
  searchTyped as searchOp,
  storeFlagsTyped as storeFlagsOp,
  copyMessageTyped as copyMessageOp,
  moveMessageTyped as moveMessageOp,
  appendMessage as appendMessageOp,
  expunge as expungeOp,
} from "./message-ops";
import {
  buildSequenceMapping,
  SequenceState,
} from "./sequence-resolver";

export class ImapSession {
  public selectedMailbox: string | null = null;
  private selectedMailboxMessageCount: number = 0;
  public mailboxReadOnly: boolean = false;
  private store: Store | null = null;
  // Mail clients pipeline aggressively during folder sync — iOS Mail sends
  // STATUS for every mailbox in one burst (hundreds of commands on accounts
  // with many virtual folders). 100 commands/sec stays far above any
  // legitimate interactive rate while still bounding a runaway client.
  private throttler: Throttler = new Throttler(100, 1000);
  private authenticated: boolean = false;
  // True when the authenticated user is the reserved read-only user
  // (`READONLY_USERNAME` = "readonly"). Any state-mutating IMAP command
  // (STORE / COPY / MOVE / APPEND / EXPUNGE, mailbox CREATE / DELETE /
  // RENAME / SUBSCRIBE / UNSUBSCRIBE) refuses with `NO [READ-ONLY]`.
  // Set once at auth time and never toggled — the flag lives only inside
  // this session and its scope is exactly one IMAP connection.
  private isReadOnlyUser: boolean = false;
  // RFC 4551 CONDSTORE: once the client sends `ENABLE CONDSTORE`, MODSEQ is
  // emitted on every subsequent FETCH response for the life of the session.
  private condstoreEnabled: boolean = false;
  private isIdling: boolean = false;
  private idleTag: string | null = null;
  private sessionId: string;

  // Sequence number mapping: index 0 = seq 1, index 1 = seq 2, etc.
  private seqState: SequenceState = {
    seqToUid: [],
    uidToSeq: new Map(),
  };

  constructor(
    private handler: ImapRequestHandler,
    public socket: Socket
  ) {
    this.sessionId = `session_${crypto.randomBytes(8).toString("hex")}`;
  }

  getCapabilities = () => {
    return getCapabilities(this.handler.isTls);
  };

  /**
   * Count messages in a mailbox. Returns null if the store is not available.
   * Used by IdleManager to send accurate EXISTS notifications.
   */
  countMailboxMessages = async (
    box: string
  ): Promise<{ total: number; recent: number } | null> => {
    if (!this.store) return null;
    const result = await this.store.countMessages(box);
    if (!result) return null;
    return { total: result.total, recent: 0 };
  };

  /**
   * Monotonic counter of plaintext IMAP response bytes written on this
   * session. Sampled before/after each command by the diagnostic log so we
   * can attribute a memory spike to the specific command that ballooned the
   * response. Bumped inside `write` rather than derived from
   * `socket.bytesWritten` because the latter reports post-TLS ciphertext
   * bytes on TLS sockets — a small offset today, but the invariant here is
   * "IMAP response payload size", not "wire bytes".
   */
  bytesWritten = 0;

  write = (data: string) => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to write to destroyed/unwritable socket", {
        component: "imap",
      });
      return false;
    }
    try {
      const ok = this.socket.write(data);
      // Only count after a successful call — a write that throws never
      // reached the wire.
      this.bytesWritten += Buffer.byteLength(data, "utf8");
      return ok;
    } catch (error) {
      logger.error("Error writing to socket", { component: "imap" }, error);
      return false;
    }
  };

  /**
   * Write a large Buffer with socket-level backpressure. Chunks the payload
   * so the kernel/OS outbound queue doesn't have to buffer the entire
   * multi-MB body in one shot, and awaits `drain` between chunks whenever
   * `socket.write` reports its high-water mark reached. This is the write
   * path FETCH BODY responses take when the payload lands as a Buffer
   * (the residual materialized paths — partial non-FULL sections,
   * header-like sub-sections). Large-body streaming paths (FULL, TEXT,
   * MIME_PART bare/`.TEXT`) use `writeStream` instead. Resolves after
   * every chunk is queued and the socket is under its high-water mark
   * again.
   *
   * The `payload` parameter is a Buffer specifically so V8 can GC the
   * intermediate JS string that `buildFullMessage` produced, and so
   * `socket.write` doesn't run a per-write UTF-8 conversion.
   */
  writeChunked = async (payload: Buffer): Promise<void> => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to writeChunked to destroyed/unwritable socket", {
        component: "imap",
      });
      return;
    }
    const written = await writeChunkedToSocket(this.socket, payload, (error) =>
      logger.error(
        "Error in writeChunked socket.write",
        { component: "imap" },
        error
      )
    );
    this.bytesWritten += written;
  };

  /**
   * Stream an async iterable of `Buffer` chunks straight to the socket
   * with backpressure. Used by BODY[] / RFC822 fetches wired through
   * `streamFromSegments` — the full body is never materialized in
   * memory; each chunk (~64 KiB base64 slice of one attachment) is
   * emitted, written, and released before the next runs. Peak transient
   * allocation stays sub-MB regardless of body size.
   *
   * Distinct from `writeChunked` because the source is a stream (the
   * chunks are produced lazily by the generator) rather than a
   * pre-materialized Buffer. Both share the same backpressure
   * discipline via `chunked-write.ts`.
   */
  writeStream = async (chunks: AsyncIterable<Buffer>): Promise<void> => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to writeStream to destroyed/unwritable socket", {
        component: "imap",
      });
      return;
    }
    const written = await writeStreamToSocket(this.socket, chunks, (error) =>
      logger.error(
        "Error in writeStream socket.write",
        { component: "imap" },
        error
      )
    );
    this.bytesWritten += written;
  };

  /**
   * Backpressure for pipelined command bursts: resolves once the connection
   * is within its command-rate budget, recording the command against the
   * window. RFC 3501 §7 requires a tagged completion for every command, so
   * over-limit commands are delayed, never dropped. Bails out early when the
   * socket dies mid-wait — there is nobody left to answer, and pacing out
   * the rest of a dead connection's queue would just burn timers.
   */
  waitForCommandSlot = async (): Promise<void> => {
    let wait = this.throttler.msUntilFree();
    while (wait > 0) {
      if (this.socket.destroyed || !this.socket.writable) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = this.throttler.msUntilFree();
    }
    this.throttler.record();
  };

  // ---------------------------------------------------------------------------
  // Simple commands
  // ---------------------------------------------------------------------------

  capability = (tag: string) => {
    this.write(
      `* CAPABILITY ${this.getCapabilities()}\r\n${tag} OK CAPABILITY completed\r\n`
    );
  };

  noop = (tag: string) => {
    this.write(`${tag} OK NOOP completed\r\n`);
  };

  check = async (tag: string) => {
    this.write(`${tag} OK CHECK completed\r\n`);
  };

  /**
   * RFC 5161 ENABLE + RFC 4551 §3.7. Acknowledge the extensions we can turn on
   * and echo them back in a single `* ENABLED` line (empty when none match).
   * CONDSTORE is the only enable-able extension today; enabling it makes every
   * later FETCH response carry MODSEQ.
   */
  enable = (tag: string, capabilities: string[]) => {
    const enabled: string[] = [];
    for (const cap of capabilities) {
      if (cap.toUpperCase() === "CONDSTORE" && !this.condstoreEnabled) {
        this.condstoreEnabled = true;
        enabled.push("CONDSTORE");
      }
    }
    const suffix = enabled.length > 0 ? ` ${enabled.join(" ")}` : "";
    this.write(`* ENABLED${suffix}\r\n${tag} OK ENABLE completed\r\n`);
  };

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  authenticate = async (
    tag: string,
    mechanism: string,
    initialResponse?: string
  ) => {
    const result = await handleAuthenticate(
      tag,
      mechanism,
      initialResponse,
      this.socket,
      this.write,
      (t) => this.handler.setPendingSaslTag(t),
      this.getCapabilities
    );
    if (result) {
      this.store = result.store;
      this.authenticated = result.authenticated;
      this.isReadOnlyUser = result.store.getUser().username === READONLY_USERNAME;
    }
  };

  login = async (tag: string, args: string[]) => {
    const result = await handleLogin(
      tag,
      args,
      this.socket,
      this.write,
      this.getCapabilities
    );
    if (result) {
      this.store = result.store;
      this.authenticated = result.authenticated;
      this.isReadOnlyUser = result.store.getUser().username === READONLY_USERNAME;
    }
  };

  /**
   * Guard for state-mutating IMAP commands. Returns `true` if the caller
   * should proceed; returns `false` after writing `NO [READ-ONLY]` for the
   * read-only user. `command` is the IMAP verb, echoed back so log-based
   * triage can pin exactly what was rejected.
   */
  private allowMutation = (tag: string, command: string): boolean => {
    if (!this.isReadOnlyUser) return true;
    this.write(
      `${tag} NO [READ-ONLY] ${command} not permitted for read-only user.\r\n`
    );
    return false;
  };

  // ---------------------------------------------------------------------------
  // Mailbox operations
  // ---------------------------------------------------------------------------

  createMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.allowMutation(tag, "CREATE")) return;
    return createMailbox(tag, mailbox, this.store, this.write);
  };

  deleteMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.allowMutation(tag, "DELETE")) return;
    return deleteMailbox(tag, mailbox, this.store, this.write);
  };

  renameMailbox = async (tag: string, oldName: string, newName: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.allowMutation(tag, "RENAME")) return;
    return renameMailbox(tag, oldName, newName, this.store, this.write);
  };

  subscribeMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.allowMutation(tag, "SUBSCRIBE")) return;
    return subscribeMailbox(tag, mailbox, this.store, this.write);
  };

  unsubscribeMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.allowMutation(tag, "UNSUBSCRIBE")) return;
    return unsubscribeMailbox(tag, mailbox, this.store, this.write);
  };

  statusMailbox = async (tag: string, mailbox: string, items: StatusItem[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return statusMailbox(tag, mailbox, items, this.store, this.write);
  };

  listMailboxes = async (tag: string, reference: string, pattern: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return listMailboxes(tag, reference, pattern, this.store, this.write);
  };

  listSubscribedMailboxes = async (
    tag: string,
    reference: string,
    pattern: string
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return listSubscribedMailboxes(
      tag,
      reference,
      pattern,
      this.store,
      this.write
    );
  };

  examineMailbox = async (tag: string, name: string) => {
    return this.selectMailbox(tag, name, true);
  };

  selectMailbox = async (
    tag: string,
    name: string,
    readOnly: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    this.mailboxReadOnly = readOnly;
    return selectMailboxOp(
      tag,
      name,
      readOnly,
      this.store,
      this.write,
      this.seqState,
      (mailbox, count) => {
        this.selectedMailbox = mailbox;
        this.selectedMailboxMessageCount = count;
      },
      () => {
        this.seqState.seqToUid = [];
        this.seqState.uidToSeq.clear();
      }
    );
  };

  // ---------------------------------------------------------------------------
  // Message operations
  // ---------------------------------------------------------------------------

  fetchMessagesTyped = async (
    tag: string,
    fetchRequest: FetchRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    // RFC 4551 §3.3.1: the CHANGEDSINCE modifier implicitly enables CONDSTORE
    // for the session — subsequent FETCH/STORE responses carry MODSEQ, and
    // this response emits it too.
    if (fetchRequest.changedSince !== undefined) {
      this.condstoreEnabled = true;
    }
    return fetchMessagesOp(
      tag,
      fetchRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write,
      this.writeChunked,
      this.writeStream,
      this.condstoreEnabled
    );
  };

  searchTyped = async (
    tag: string,
    searchRequest: SearchRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    return searchOp(
      tag,
      searchRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write
    );
  };

  storeFlagsTyped = async (
    tag: string,
    storeRequest: StoreRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    if (!this.allowMutation(tag, isUidCommand ? "UID STORE" : "STORE")) return;
    return storeFlagsOp(
      tag,
      storeRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write,
      this.condstoreEnabled
    );
  };

  copyMessageTyped = async (
    tag: string,
    copyRequest: CopyRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store || !this.selectedMailbox) {
      return this.write(`${tag} NO Not authenticated or no mailbox selected.\r\n`);
    }
    if (!this.allowMutation(tag, isUidCommand ? "UID COPY" : "COPY")) return;
    return copyMessageOp(
      tag,
      copyRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write
    );
  };

  moveMessageTyped = async (
    tag: string,
    moveRequest: MoveRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store || !this.selectedMailbox) {
      return this.write(`${tag} NO Not authenticated or no mailbox selected.\r\n`);
    }
    if (!this.allowMutation(tag, isUidCommand ? "UID MOVE" : "MOVE")) return;
    return moveMessageOp(
      tag,
      moveRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write
    );
  };

  appendMessage = async (tag: string, appendRequest: AppendRequest) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.allowMutation(tag, "APPEND")) return;
    return appendMessageOp(
      tag,
      appendRequest,
      this.store,
      this.selectedMailbox,
      this.write,
      async () => {
        await buildSequenceMapping(
          this.store,
          this.selectedMailbox,
          this.seqState
        );
      }
    );
  };

  expunge = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    if (!this.allowMutation(tag, "EXPUNGE")) return;
    return expungeOp(
      tag,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write
    );
  };

  // ---------------------------------------------------------------------------
  // Mailbox close / deselect
  // ---------------------------------------------------------------------------

  closeMailbox = (tag: string, unselect = false) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    this.selectedMailbox = null;
    this.selectedMailboxMessageCount = 0;
    this.seqState.seqToUid = [];
    this.seqState.uidToSeq.clear();
    const verb = unselect ? "UNSELECT" : "CLOSE";
    this.write(`${tag} OK ${verb} completed\r\n`);
  };

  // ---------------------------------------------------------------------------
  // LOGOUT
  // ---------------------------------------------------------------------------

  logout = async (tag: string) => {
    if (this.isIdling) {
      this.endIdle();
    }
    this.store = null;
    this.selectedMailbox = null;
    this.selectedMailboxMessageCount = 0;
    this.seqState.seqToUid = [];
    this.seqState.uidToSeq.clear();
    this.authenticated = false;
    this.write("* BYE IMAP4rev1 Server logging out\r\n");
    this.write(`${tag} OK LOGOUT completed\r\n`);
    this.socket.end();
  };

  // ---------------------------------------------------------------------------
  // IDLE
  // ---------------------------------------------------------------------------

  startIdle = async (tag: string) => {
    if (!this.authenticated || !this.selectedMailbox || !this.store) {
      return this.write(
        `${tag} NO Not authenticated or no mailbox selected\r\n`
      );
    }
    if (this.isIdling) {
      return this.write(`${tag} BAD Already in IDLE mode\r\n`);
    }
    this.isIdling = true;
    this.idleTag = tag;

    // A client in IDLE may send no traffic for the whole window; raise the
    // raw-socket inactivity timeout past the idle-manager's force-terminate so
    // the socket doesn't tear the connection down mid-IDLE. Reset on endIdle.
    this.socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS);

    const user = this.store.getUser();
    idleManager.addIdleSession(
      this.sessionId,
      this,
      tag,
      this.selectedMailbox,
      user.username
    );

    this.write("+ idling\r\n");
    // DONE is detected by the handler's main line buffer (handler.ts), which
    // reassembles split TCP chunks and \r\n-delimited lines. A separate raw
    // socket "data" listener here used to miss split ("DO" + "NE\r\n") and
    // pipelined ("DONE\r\nA4 NOOP\r\n") DONEs, stranding the session in IDLE.
  };

  endIdle = (reason?: string) => {
    if (!this.isIdling || !this.idleTag) return;
    this.isIdling = false;
    const tag = this.idleTag;
    this.idleTag = null;
    idleManager.removeIdleSession(this.sessionId);
    // Back to normal command mode — restore the short inactivity timeout.
    this.socket.setTimeout(SOCKET_TIMEOUT_MS);
    const suffix = reason ? ` (${reason})` : "";
    this.write(`${tag} OK IDLE terminated${suffix}\r\n`);
  };

  isInIdleMode = (): boolean => {
    return this.isIdling;
  };

  getSessionId = (): string => {
    return this.sessionId;
  };

  cleanup = () => {
    if (this.isIdling) {
      idleManager.removeIdleSession(this.sessionId);
      this.isIdling = false;
      this.idleTag = null;
      logger.debug("IDLE session cleaned up on socket close", {
        component: "imap",
        sessionId: this.sessionId,
      });
    }
  };

  // ---------------------------------------------------------------------------
  // STARTTLS
  // ---------------------------------------------------------------------------

  startTls = async (tag: string) => {
    const { SSL_CERTIFICATE = "", SSL_CERTIFICATE_KEY = "" } = process.env;

    const secureSocket = await new Promise<Socket>((resolve, reject) => {
      const s = new TLSSocket(this.socket, {
        isServer: true,
        key: readFileSync(SSL_CERTIFICATE_KEY),
        cert: readFileSync(SSL_CERTIFICATE),
      });
      s.once("secure", () => resolve(s));
      s.once("error", reject);
    });

    this.socket = secureSocket;
    this.handler.setSocket(secureSocket);
    this.write(`${tag} OK Begin TLS negotiation now\r\n`);
  };
}
