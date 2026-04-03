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
  AppendRequest,
  StatusItem,
} from "./types";
import { idleManager } from "./idle-manager";
import { getCapabilities } from "./capabilities";
import { ImapRequestHandler } from "./handler";

// Extracted module helpers
import { handleAuthenticate, handleLogin } from "./auth";
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
  private throttler: Throttler = new Throttler();
  private authenticated: boolean = false;
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
    return getCapabilities(this.handler.port);
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

  write = (data: string) => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to write to destroyed/unwritable socket", {
        component: "imap",
      });
      return false;
    }
    try {
      return this.socket.write(data);
    } catch (error) {
      logger.error("Error writing to socket", { component: "imap" }, error);
      return false;
    }
  };

  isThrottled(): boolean {
    return this.throttler.isThrottled();
  }

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
    }
  };

  // ---------------------------------------------------------------------------
  // Mailbox operations
  // ---------------------------------------------------------------------------

  createMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return createMailbox(tag, mailbox, this.store, this.write);
  };

  deleteMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return deleteMailbox(tag, mailbox, this.store, this.write);
  };

  renameMailbox = async (tag: string, oldName: string, newName: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return renameMailbox(tag, oldName, newName, this.store, this.write);
  };

  subscribeMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return subscribeMailbox(tag, mailbox, this.store, this.write);
  };

  unsubscribeMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return unsubscribeMailbox(tag, mailbox, this.store, this.write);
  };

  statusMailbox = async (tag: string, mailbox: string, items: StatusItem[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return statusMailbox(tag, mailbox, items, this.store, this.write);
  };

  listMailboxes = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return listMailboxes(tag, this.store, this.write);
  };

  listSubscribedMailboxes = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return listSubscribedMailboxes(tag, this.store, this.write);
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
    return fetchMessagesOp(
      tag,
      fetchRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write
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
    return storeFlagsOp(
      tag,
      storeRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write
    );
  };

  copyMessageTyped = async (
    tag: string,
    _copyRequest: CopyRequest,
    _isUidCommand: boolean = false
  ) => {
    return copyMessageOp(tag, _copyRequest, _isUidCommand, this.write);
  };

  appendMessage = async (tag: string, appendRequest: AppendRequest) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
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

    const user = this.store.getUser();
    idleManager.addIdleSession(
      this.sessionId,
      this,
      tag,
      this.selectedMailbox,
      user.username
    );

    this.write("+ idling\r\n");
    this.socket.on("data", this.handleIdleData);
  };

  private handleIdleData = (data: Buffer) => {
    if (!this.isIdling) return;
    const command = data.toString().trim().toUpperCase();
    if (command === "DONE") {
      this.endIdle();
    }
  };

  private endIdle = () => {
    if (!this.isIdling || !this.idleTag) return;
    this.isIdling = false;
    const tag = this.idleTag;
    this.idleTag = null;
    idleManager.removeIdleSession(this.sessionId);
    this.socket.off("data", this.handleIdleData);
    this.write(`${tag} OK IDLE terminated\r\n`);
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
      this.socket.off("data", this.handleIdleData);
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
