/**
 * IMAP request handler - translates parsed commands to session method calls
 */

import { Socket } from "net";
import { ImapSession } from "./session";
import { ImapRequest } from "./types";
import { parseCommand } from "./parsers";
import { imapTrace } from "./trace";
import { getBodyBudgetWaitMs, runInBodyBudgetContext } from "./body-budget";
import { SOCKET_TIMEOUT_MS } from "./idle-manager";
import { logger } from "server";

// Per-command diagnostic log thresholds. A command is "interesting"
// (logged at INFO) if ANY of these thresholds is exceeded. Otherwise
// the payload drops to DEBUG — same shape, same fields, but suppressed
// by prod's INFO-level filter so the noise floor doesn't drown the tail
// during a client retry storm. Chosen so that:
// - A `UID FETCH X (BODY)` on a multi-MB message ALWAYS logs (huge
//   response, non-trivial duration, RSS delta).
// - A `UID FETCH X (FLAGS)` under an idle-loop poll drops to DEBUG
//   (0-byte-ish response, sub-ms, no RSS delta).
// - Anything abnormally slow (`durationMs >= 100`) surfaces regardless
//   of size — a slow FLAGS query is diagnosable evidence for a DB /
//   pool issue.
const INTERESTING_RSS_DELTA_MB = 1;
const INTERESTING_DURATION_MS = 100;
const INTERESTING_RESPONSE_BYTES = 4096;

// Short human-readable summary of a request for the per-command diagnostic
// log. Never emits mail contents. Cap at ~200 chars so a runaway pipeline of
// FETCH commands doesn't blow the log volume; the sequence range + item
// names are enough to identify OOM-triggering shapes (full-mailbox FETCH,
// BODY[] on a large range, etc.).
export function describeImapCommand(request: ImapRequest): string {
  const summary = (s: string) => (s.length > 180 ? s.slice(0, 177) + "..." : s);
  const rangesOf = (rs: { start: number; end?: number }[]) =>
    rs
      .map((r) => (r.end === undefined ? String(r.start) : `${r.start}:${r.end}`))
      .join(",");

  switch (request.type) {
    case "UID":
      return `UID ${describeImapCommand(request.data.request)}`;
    case "FETCH": {
      const seq = rangesOf(request.data.sequenceSet.ranges);
      const items = request.data.dataItems?.map((i) => i.type).join(" ") ?? "";
      return summary(`FETCH ${seq} (${items})`);
    }
    case "STORE": {
      const seq = rangesOf(request.data.sequenceSet.ranges);
      return summary(`STORE ${seq} ${request.data.operation} ${request.data.flags.join(" ")}`);
    }
    case "SEARCH":
      // SEARCH criteria can be arbitrarily nested; summarize root types only.
      return summary(`SEARCH ${JSON.stringify(request.data.criteria ?? "").slice(0, 120)}`);
    case "COPY":
      return summary(`COPY ${rangesOf(request.data.sequenceSet.ranges)} ${request.data.mailbox}`);
    case "MOVE":
      return summary(`MOVE ${rangesOf(request.data.sequenceSet.ranges)} ${request.data.mailbox}`);
    case "SELECT":
    case "EXAMINE":
      return summary(`${request.type} ${request.data.mailbox}`);
    case "LIST":
    case "LSUB":
      return summary(`${request.type} "${request.data.reference}" "${request.data.pattern}"`);
    case "STATUS":
      return summary(`STATUS ${request.data.mailbox} (${request.data.items.join(" ")})`);
    case "APPEND":
      return summary(`APPEND ${request.data.mailbox} ${request.data.message?.length ?? 0}B`);
    case "CREATE":
    case "DELETE":
    case "RENAME":
    case "SUBSCRIBE":
    case "UNSUBSCRIBE":
    case "GETQUOTAROOT":
      return summary(`${request.type} ${JSON.stringify(request.data).slice(0, 160)}`);
    case "LOGIN":
      // NEVER emit the password.
      return summary(`LOGIN ${request.data.username}`);
    case "AUTHENTICATE":
      return summary(`AUTHENTICATE ${request.data.mechanism}`);
    case "ENABLE":
      return summary(`ENABLE ${request.data.capabilities.join(" ")}`);
    default:
      return request.type;
  }
}

export class ImapRequestHandler {
  private session: ImapSession | null = null;
  private _pendingSaslTag: string | null = null;

  constructor(public isTls = false) {}

  setPendingSaslTag = (tag: string) => {
    this._pendingSaslTag = tag;
  };

  setSocket = (socket: Socket) => {
    if (this.session) {
      this.session.socket.removeAllListeners("data");
      this.session.socket.removeAllListeners("close");
      this.session.socket.removeAllListeners("error");
      this.session.socket.removeAllListeners("timeout");
    }

    const session = new ImapSession(this, socket);
    this.session = session;

    let buffer = "";

    // State for APPEND literal accumulation
    let pendingAppendLine: string | null = null;
    let literalBytesNeeded = 0;

    // pendingSaslTag is stored on this (class property) so session can set it

    // Per-session serial drain guard. Node emits `data` events without
    // awaiting the async handler, so before this guard existed each TCP
    // segment spawned its own async loop reading and mutating the shared
    // `buffer` — and, worse, calling `handleRequest`/`session.write` in
    // parallel. Pipelined FETCHes on one session (iOS Mail issues N
    // `UID FETCH (BODY.PEEK[]<off.393216>)` slices in a burst for a
    // multi-MB body) would interleave: `writeFetchResponse` writes a
    // literal-length header `{N}\r\n`, `await writeStream(...)`, then `)`.
    // Under WAN backpressure the `await` yields, and the concurrent
    // handler's synchronous `write()` for the next FETCH injects its own
    // `* n FETCH (…` header into the middle of the still-streaming
    // literal — iOS's parser desyncs and drops the session ("Cannot Get
    // Mail" modal). RFC 3501 explicitly permits serial command execution
    // on a single connection, so we serialize.
    let draining = false;
    const drainCommands = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (true) {
          // If accumulating literal data for APPEND, consume raw bytes first
          if (pendingAppendLine !== null) {
            if (buffer.length < literalBytesNeeded) return;
            const literalData = buffer.substring(0, literalBytesNeeded);
            buffer = buffer.substring(literalBytesNeeded);
            // Skip optional \r\n after literal
            if (buffer.startsWith("\r\n")) {
              buffer = buffer.substring(2);
            }

            const fullInput = pendingAppendLine + "\r\n" + literalData;
            pendingAppendLine = null;
            literalBytesNeeded = 0;

            try {
              const parseResult = parseCommand(fullInput.trim());
              if (parseResult.success && parseResult.value) {
                const { tag, request } = parseResult.value;
                await this.handleRequest(tag, request);
              } else {
                logger.debug("Parse failed (APPEND literal)", {
                  component: "imap.parser",
                  error: parseResult.error
                });
                const tag = fullInput.trim().split(" ")[0] || "BAD";
                session.write(`${tag} BAD ${parseResult.error || "Invalid APPEND command"}\r\n`);
              }
            } catch (error) {
              logger.error("Error processing APPEND literal", { component: "imap" }, error);
              session.write(`* BAD Internal server error\r\n`);
            }
            continue;
          }

          const lineEnd = buffer.indexOf("\r\n");
          if (lineEnd === -1) return;

          const line = buffer.substring(0, lineEnd);
          buffer = buffer.substring(lineEnd + 2);

          // Handle SASL challenge response (client sends base64 after "+ " challenge)
          if (this._pendingSaslTag !== null) {
            const tag = this._pendingSaslTag;
            this._pendingSaslTag = null;
            // Client may send "*" to cancel authentication
            if (line.trim() === "*") {
              session.write(`${tag} BAD Authentication cancelled\r\n`);
            } else {
              await session.authenticate(tag, "PLAIN", line.trim());
            }
            continue;
          }

          if (!line.trim()) continue;

          // The only valid client input during IDLE is "DONE". This line
          // buffer already reassembles split TCP chunks and pipelined input,
          // so handle DONE here: terminate IDLE and fall through so any
          // command pipelined after DONE (e.g. "DONE\r\nA4 NOOP\r\n") is
          // processed on the next loop iteration. Non-DONE input during IDLE
          // is ignored per RFC 2177.
          if (session.isInIdleMode()) {
            if (line.trim().toUpperCase() === "DONE") {
              session.endIdle();
            }
            continue;
          }

          logger.debug("IMAP command received", {
            component: "imap",
            command: line.trim(),
            mailbox: session.selectedMailbox
          });
          imapTrace("in", session.getSessionId(), line.trim());

          // Pace pipelined bursts. RFC 3501 §7 requires a tagged
          // completion for every command, so over-limit commands are
          // delayed, never skipped — clients pipeline heavily during
          // folder sync (iOS Mail sends STATUS for every mailbox in one
          // burst after LIST).
          await session.waitForCommandSlot();

          // Detect APPEND command with a literal size indicator {N} or {N+}
          // e.g. "a001 APPEND INBOX (\Seen) {512}"
          // When found, switch to literal accumulation mode instead of parsing now.
          const literalMatch = /\{(\d+)(\+?)\}\s*$/.exec(line.trim());
          if (literalMatch) {
            const upperLine = line.trim().toUpperCase();
            // Only intercept APPEND literals here; other commands with literals
            // (e.g. LOGIN with quoted strings) don't need this treatment.
            const parts = upperLine.split(/\s+/);
            const commandWord = parts[1] || parts[0];
            if (commandWord === "APPEND") {
              pendingAppendLine = line.trim();
              literalBytesNeeded = parseInt(literalMatch[1], 10);
              // Synchronizing literals {N} (without +) require a continuation
              // response before the client will send the literal data.
              // Non-synchronizing literals {N+} (LITERAL+) do not.
              const isSynchronizing = !literalMatch[2];
              if (isSynchronizing) {
                session.write("+ go ahead\r\n");
              }
              continue;
            }
          }

          try {
            // Parse the command using the typed parser
            const parseResult = parseCommand(line.trim());

            if (parseResult.success && parseResult.value) {
              const { tag, request } = parseResult.value;
              await this.handleRequest(tag, request);
            } else {
              // If parsing failed, send error response only if socket is writable
              logger.debug("Parse failed", {
                component: "imap.parser",
                input: line.trim(),
                error: parseResult.error
              });
              const parts = line.trim().split(" ");
              const tag = parts[0] || "BAD";
              const errorMsg = parseResult.error || "Invalid command syntax";
              session.write(`${tag} BAD ${errorMsg}\r\n`);
            }
          } catch (error) {
            logger.error("Error processing command", { component: "imap" }, error);
            // Only send error response if socket is still writable
            const parts = line.trim().split(" ");
            const tag = parts[0] || "BAD";
            session.write(`${tag} BAD Internal server error\r\n`);
          }
        }
      } catch (error) {
        logger.error("Error processing data", { component: "imap" }, error);
        if (!socket.destroyed) {
          socket.destroy();
        }
      } finally {
        draining = false;
      }
    };

    socket.on("data", (data) => {
      // Sync-only: append to the shared buffer, then wake the drain.
      // The `data` event fires synchronously per TCP segment; any await
      // here would let a second segment race the buffer append. Keep this
      // handler synchronous — all async work belongs inside `drainCommands`
      // which owns the `draining` guard.
      try {
        buffer += data.toString();
      } catch (error) {
        logger.error("Error appending data to buffer", { component: "imap" }, error);
        if (!socket.destroyed) socket.destroy();
        return;
      }
      // Fire-and-forget: `drainCommands` self-serializes via `draining`.
      // Errors inside are already logged; catch here just to prevent an
      // unhandled-rejection.
      void drainCommands().catch((error) => {
        logger.error("Unhandled drain error", { component: "imap" }, error);
      });
    });

    socket.on("close", () => {
      logger.debug("IMAP connection closed", { component: "imap" });
      session.cleanup();
    });

    socket.on("error", (error) => {
      if (!(error as Error).message?.includes("ECONNRESET")) {
        logger.error("IMAP socket error", { component: "imap" }, error);
      }
      if (!socket.destroyed) {
        socket.destroy();
      }
    });

    // Set socket timeout to prevent hanging connections
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("timeout", () => {
      logger.info("IMAP socket timeout", { component: "imap" });
      session.write("* BYE Timeout\r\n");
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  };

  /**
   * Handle a parsed IMAP request by delegating to appropriate session methods
   */
  async handleRequest(tag: string, request: ImapRequest): Promise<void> {
    if (!this.session) {
      logger.error("Invalid session: Use setSocket to start a session", { component: "imap" });
      return;
    }

    // Per-command diagnostic: RSS delta + bytes emitted to the client + wall
    // duration, so a memory spike can be attributed to a specific command
    // rather than only to a coarse metrics-poll window. Sampled from
    // `session.bytesWritten` (session-scoped counter) rather than wrapping
    // `session.write` — the wrap approach was racy under the pre-serialized
    // data-event handler and could restore an orphan `originalWrite` from a
    // nested handler and permanently break the wrap for the rest of the
    // socket's lifetime. Commands are now serialized per session (see the
    // `drainCommands` note above), so cross-command interleaving on the
    // same session is gone; the counter approach stays because it also
    // avoids the wrap-restore hazard.
    //
    // RSS is process-wide, not session-scoped: under multi-socket load two
    // concurrent commands (on DIFFERENT sessions) both see the same
    // rssDelta. `remote` in the log lets triage disambiguate.
    const session = this.session;
    const startedAt = performance.now();
    const memBefore = process.memoryUsage();
    const rssBefore = memBefore.rss;
    const bytesBefore = session.bytesWritten;

    // Bind a body-budget wait ledger to this command's async scope so
    // every `withBodyBudget` acquire made deeper in the FETCH path
    // (across await boundaries + nested calls) attributes its wait to
    // THIS command's totals, not a racing sibling command on another
    // socket. Reads via `getBodyBudgetWaitMs()` in the finally below.
    // See `body-budget.ts`.
    return runInBodyBudgetContext(async () => {
    try {
      switch (request.type) {
        case "CAPABILITY":
          session.capability(tag);
          break;

        case "NOOP":
          session.noop(tag);
          break;

        case "LOGIN":
          await session.login(tag, [
            request.data.username,
            request.data.password
          ]);
          break;

        case "AUTHENTICATE":
          await session.authenticate(
            tag,
            request.data.mechanism,
            request.data.initialResponse
          );
          break;

        case "LIST":
          await session.listMailboxes(
            tag,
            request.data.reference,
            request.data.pattern
          );
          break;
        case "LSUB":
          await session.listSubscribedMailboxes(
            tag,
            request.data.reference,
            request.data.pattern
          );
          break;

        case "SELECT":
          await session.selectMailbox(tag, request.data.mailbox);
          break;

        case "EXAMINE":
          await session.examineMailbox(tag, request.data.mailbox);
          break;

        case "CREATE":
          await session.createMailbox(tag, request.data.mailbox);
          break;

        case "DELETE":
          await session.deleteMailbox(tag, request.data.mailbox);
          break;

        case "RENAME":
          await session.renameMailbox(
            tag,
            request.data.oldName,
            request.data.newName
          );
          break;

        case "SUBSCRIBE":
          await session.subscribeMailbox(tag, request.data.mailbox);
          break;

        case "UNSUBSCRIBE":
          await session.unsubscribeMailbox(tag, request.data.mailbox);
          break;

        case "STATUS":
          await session.statusMailbox(
            tag,
            request.data.mailbox,
            request.data.items
          );
          break;

        case "APPEND":
          await session.appendMessage(tag, request.data);
          break;

        case "IDLE":
          await session.startIdle(tag);
          break;

        case "CHECK":
          await session.check(tag);
          break;

        case "FETCH":
          await session.fetchMessagesTyped(tag, request.data, false);
          break;

        case "SEARCH":
          await session.searchTyped(tag, request.data, false);
          break;

        case "STORE":
          await session.storeFlagsTyped(tag, request.data, false);
          break;

        case "COPY":
          await session.copyMessageTyped(tag, request.data, false);
          break;

        case "MOVE":
          await session.moveMessageTyped(tag, request.data, false);
          break;

        case "UID":
          await this.handleUidCommand(tag, request.data);
          break;

        case "CLOSE":
          session.closeMailbox(tag);
          break;

        case "EXPUNGE":
          await session.expunge(tag);
          break;

        case "LOGOUT":
          await session.logout(tag);
          break;

        case "ID":
          session.write(`* ID NIL\r\n${tag} OK ID completed\r\n`);
          break;

        case "STARTTLS":
          session.startTls(tag);
          break;

        case "NAMESPACE":
          // RFC 2342: single personal namespace, no other/shared namespaces
          session.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
          break;

        case "ENABLE":
          // RFC 5161 / RFC 4551 §3.7: enable CONDSTORE (the one extension we
          // support enabling) and echo back what was activated.
          session.enable(tag, request.data.capabilities);
          break;

        case "UNSELECT":
          // RFC 3691: like CLOSE but without expunging; deselect the current mailbox
          session.closeMailbox(tag, true);
          break;

        case "GETQUOTAROOT":
          // RFC 2087: quota not supported, return empty quota
          session.write(`${tag} NO Quota not supported\r\n`);
          break;

        default:
          session.write(`${tag} BAD Unknown command\r\n`);
          break;
      }
    } catch (error) {
      logger.error("Error handling IMAP request", { component: "imap", tag, type: request.type }, error);
      session.write(`${tag} BAD Internal server error\r\n`);
    } finally {
      const memAfter = process.memoryUsage();
      const rssAfter = memAfter.rss;
      const socket = session.socket;
      const rssDeltaMB = Math.round((rssAfter - rssBefore) / 1_048_576);
      const responseBytes = session.bytesWritten - bytesBefore;
      const durationMs = Math.round(performance.now() - startedAt);
      // Threshold-gate the per-command line. Under a client retry storm
      // (observed 2026-07-28: 208.82.98.54 issuing ~1700 UID FETCH FLAGS
      // /min per socket → 1700 lines/min on inbox alone), the noise floor
      // — commands with zero RSS delta AND sub-INTERESTING_DURATION_MS
      // duration AND sub-INTERESTING_RESPONSE_BYTES response — drowns
      // journald's 10k-line tail cap in ~6 min and starves triage of the
      // interesting samples (the ones that actually moved RSS or ran
      // slow). Keep the interesting ones at INFO where the alarm embed
      // and default triage tail find them; drop the noise to DEBUG.
      //
      // What "DEBUG" means in prod: `logger.ts:shouldLog` compares
      // against `LOG_LEVEL` (default `"info"`), and `debug < info` short-
      // circuits BEFORE console.log runs — no stdout write, so journald
      // never sees the line. `journalctl -p debug` can't recover it;
      // raising verbosity requires `LOG_LEVEL=debug` + a restart, which
      // kills the storm's active sockets. That's fine for the OOM /
      // latency triage this fix targets: samples that moved RSS or ran
      // slow still land at INFO with the full payload. What DOES move
      // off-log is per-IP command-rate attribution during a live storm
      // (e.g. "how many UID FLAGS from :50613 in this minute?") — that
      // signal now lives on the monitor sidecar's docker-stats poller,
      // not in the app's log stream.
      //
      // Auth events (LOGIN / AUTHENTICATE) DO NOT rely on this gate;
      // `auth.ts` emits its own `logger.info("IMAP LOGIN success", ...)`
      // / `IMAP AUTHENTICATE success` line on the success path so the
      // audit surface holds even when bcrypt completes in under
      // `INTERESTING_DURATION_MS` on strong hardware.
      const isInteresting =
        Math.abs(rssDeltaMB) >= INTERESTING_RSS_DELTA_MB ||
        durationMs >= INTERESTING_DURATION_MS ||
        responseBytes >= INTERESTING_RESPONSE_BYTES;
      // Body-budget wait attribution (#726): when many sockets pipeline
      // distinct large-body FETCHes concurrently, most of the caller's
      // duration is spent WAITING for a body-budget slot rather than
      // doing DB / serialization work. Log the wait so an OOM / latency
      // triage can attribute FETCH latency to backpressure vs the app.
      // Read from the request-scoped AsyncLocalStorage ledger — a
      // module-global cell would race with concurrent commands on
      // other sockets.
      const waitedForBodyBudgetMs = Math.round(getBodyBudgetWaitMs());
      // Attribution of the per-command RSS delta by memory class. `rss` is
      // OS-reported (Node process resident) — the other four are V8/Node
      // internal counters that partition where the growth actually lives:
      //   heapUsed / heapTotal — V8 JS heap (objects, strings, closures)
      //   external            — Buffers + typed arrays bound to a V8 wrapper
      //   arrayBuffers        — subset of `external` for ArrayBuffer backing
      //                         stores (raw Buffer allocations sit here)
      // Under a same-socket pipelined burst, seeing external/arrayBuffers
      // climb points at Buffer accumulation (pgTextChunks / socket outbound
      // / attachment reads); seeing heapUsed climb points at retained JS
      // references (mail-row copies, segment lists); seeing rss climb
      // without any of the above pointing at Node-internal buffers.
      const heapUsedDeltaKB = Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024);
      const heapTotalDeltaKB = Math.round((memAfter.heapTotal - memBefore.heapTotal) / 1024);
      const externalDeltaKB = Math.round((memAfter.external - memBefore.external) / 1024);
      const arrayBuffersDeltaKB = Math.round(
        (memAfter.arrayBuffers - memBefore.arrayBuffers) / 1024
      );
      // Attribution of which BODY[] variant a FETCH command uses.
      // `bodyFullPartial` = the client sent `BODY[]<start.length>`, which
      // routes to `streamPartialFromSegments`; `bodyFullStream` = a full
      // `BODY[]` or `RFC822`, which routes to `streamFromSegments`. Both
      // walk the segment list rather than materializing text+html into the
      // V8 heap, so under an iOS retry storm this pair attributes RSS by
      // request shape, not by materialized-vs-streamed. Non-FETCH commands
      // set both to 0.
      let bodyFullPartial = 0;
      let bodyFullStream = 0;
      const collectBodyShapes = (r: ImapRequest): void => {
        if (r.type === "UID") { collectBodyShapes(r.data.request); return; }
        if (r.type !== "FETCH") return;
        for (const item of r.data.dataItems ?? []) {
          if (item.type === "BODY" && item.section.type === "FULL") {
            if (item.partial) bodyFullPartial += 1;
            else bodyFullStream += 1;
          } else if (item.type === "RFC822") {
            // RFC822 aliases BODY[] and has no partial-range form (RFC 3501
            // §6.4.5), so it always counts as a full fetch.
            bodyFullStream += 1;
          }
        }
      };
      collectBodyShapes(request);
      const payload = {
        component: "imap",
        tag,
        cmd: describeImapCommand(request),
        mailbox: session.selectedMailbox,
        remote: socket ? `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}` : "?",
        rssBeforeMB: Math.round(rssBefore / 1_048_576),
        rssAfterMB: Math.round(rssAfter / 1_048_576),
        rssDeltaMB,
        heapUsedAfterMB: Math.round(memAfter.heapUsed / 1_048_576),
        heapTotalAfterMB: Math.round(memAfter.heapTotal / 1_048_576),
        externalAfterMB: Math.round(memAfter.external / 1_048_576),
        arrayBuffersAfterMB: Math.round(memAfter.arrayBuffers / 1_048_576),
        heapUsedDeltaKB,
        heapTotalDeltaKB,
        externalDeltaKB,
        arrayBuffersDeltaKB,
        bodyFullPartial,
        bodyFullStream,
        responseBytes,
        durationMs,
        waitedForBodyBudgetMs,
      };
      if (isInteresting) {
        logger.info("IMAP command completed", payload);
      } else {
        logger.debug("IMAP command completed", payload);
      }
    }
    });
  }

  /**
   * Handle UID commands by delegating to the appropriate sub-command with UID context
   */
  private async handleUidCommand(
    tag: string,
    data: { command: string; request: ImapRequest }
  ): Promise<void> {
    if (!this.session) {
      logger.error("Invalid session: Use setSocket to start a session", { component: "imap" });
      return;
    }

    // Handle the inner request but pass UID context to session methods
    const { command, request } = data;

    try {
      switch (request.type) {
        case "FETCH":
          await this.session.fetchMessagesTyped(tag, request.data, true);
          break;

        case "SEARCH":
          await this.session.searchTyped(tag, request.data, true);
          break;

        case "STORE":
          await this.session.storeFlagsTyped(tag, request.data, true);
          break;

        case "COPY":
          await this.session.copyMessageTyped(tag, request.data, true);
          break;

        case "MOVE":
          await this.session.moveMessageTyped(tag, request.data, true);
          break;

        default:
          this.session.write(`${tag} BAD UID ${command} not supported\r\n`);
          break;
      }
    } catch (error) {
      logger.error("Error handling UID command", { component: "imap", tag, command }, error);
      this.session.write(`${tag} BAD Internal server error\r\n`);
    }
  }
}
