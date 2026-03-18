/**
 * IMAP request handler - translates parsed commands to session method calls
 */

import { Socket } from "net";
import { ImapSession } from "./session";
import { ImapRequest } from "./types";
import { parseCommand } from "./parsers";
import { logger } from "server";

export class ImapRequestHandler {
  private session: ImapSession | null = null;
  private _pendingSaslTag: string | null = null;

  constructor(public port = 143) {}

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

    socket.on("data", async (data) => {
      try {
        buffer += data.toString();

        // Process complete lines
        let lineEnd;
        while (true) {
          // If accumulating literal data for APPEND, consume raw bytes first
          if (pendingAppendLine !== null) {
            if (buffer.length < literalBytesNeeded) {
              // Wait for more data
              break;
            }
            // We have enough bytes — reconstruct the full APPEND input and parse
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

          lineEnd = buffer.indexOf("\r\n");
          if (lineEnd === -1) break;

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

          if (line.trim()) {
            // When session is in IDLE mode, skip normal command processing —
            // the IDLE data handler on session.ts handles DONE exclusively.
            if (session.isInIdleMode()) {
              continue;
            }

            logger.debug("IMAP command received", {
              component: "imap",
              command: line.trim(),
              mailbox: session.selectedMailbox
            });

            // Check throttling before processing
            if (session.isThrottled()) {
              session.write(
                "* NO [TEMPORARY UNAVAILABLE] Server is busy. Please try again later.\r\n"
              );
              continue;
            }

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
        }
      } catch (error) {
        logger.error("Error processing data", { component: "imap" }, error);
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
    });

    socket.on("close", () => {
      logger.debug("IMAP connection closed", { component: "imap" });
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
    socket.setTimeout(300000); // 5 minutes
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

    try {
      switch (request.type) {
        case "CAPABILITY":
          this.session.capability(tag);
          break;

        case "NOOP":
          this.session.noop(tag);
          break;

        case "LOGIN":
          await this.session.login(tag, [
            request.data.username,
            request.data.password
          ]);
          break;

        case "AUTHENTICATE":
          await this.session.authenticate(
            tag,
            request.data.mechanism,
            request.data.initialResponse
          );
          break;

        case "LIST":
          await this.session.listMailboxes(tag);
          break;
        case "LSUB":
          await this.session.listSubscribedMailboxes(tag);
          break;

        case "SELECT":
          await this.session.selectMailbox(tag, request.data.mailbox);
          break;

        case "EXAMINE":
          await this.session.examineMailbox(tag, request.data.mailbox);
          break;

        case "CREATE":
          await this.session.createMailbox(tag, request.data.mailbox);
          break;

        case "DELETE":
          await this.session.deleteMailbox(tag, request.data.mailbox);
          break;

        case "RENAME":
          await this.session.renameMailbox(
            tag,
            request.data.oldName,
            request.data.newName
          );
          break;

        case "SUBSCRIBE":
          await this.session.subscribeMailbox(tag, request.data.mailbox);
          break;

        case "UNSUBSCRIBE":
          await this.session.unsubscribeMailbox(tag, request.data.mailbox);
          break;

        case "STATUS":
          await this.session.statusMailbox(
            tag,
            request.data.mailbox,
            request.data.items
          );
          break;

        case "APPEND":
          await this.session.appendMessage(tag, request.data);
          break;

        case "IDLE":
          await this.session.startIdle(tag);
          break;

        case "CHECK":
          await this.session.check(tag);
          break;

        case "FETCH":
          await this.session.fetchMessagesTyped(tag, request.data, false);
          break;

        case "SEARCH":
          await this.session.searchTyped(tag, request.data, false);
          break;

        case "STORE":
          await this.session.storeFlagsTyped(tag, request.data, false);
          break;

        case "COPY":
          await this.session.copyMessageTyped(tag, request.data, false);
          break;

        case "UID":
          await this.handleUidCommand(tag, request.data);
          break;

        case "CLOSE":
          this.session.closeMailbox(tag);
          break;

        case "EXPUNGE":
          await this.session.expunge(tag);
          break;

        case "LOGOUT":
          await this.session.logout(tag);
          break;

        case "ID":
          this.session.write(`* ID NIL\r\n${tag} OK ID completed\r\n`);
          break;

        case "STARTTLS":
          await this.session.startTls(tag);
          break;

        case "NAMESPACE":
          // RFC 2342: single personal namespace, no other/shared namespaces
          this.session.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
          break;

        case "ENABLE":
          // RFC 5161: acknowledge requested capabilities; we don't activate any extensions
          this.session.write(`* ENABLED\r\n${tag} OK ENABLE completed\r\n`);
          break;

        case "UNSELECT":
          // RFC 3691: like CLOSE but without expunging; deselect the current mailbox
          this.session.closeMailbox(tag, true);
          break;

        case "GETQUOTAROOT":
          // RFC 2087: quota not supported, return empty quota
          this.session.write(`${tag} NO Quota not supported\r\n`);
          break;

        default:
          this.session.write(`${tag} BAD Unknown command\r\n`);
          break;
      }
    } catch (error) {
      logger.error("Error handling IMAP request", { component: "imap", tag, type: request.type }, error);
      this.session.write(`${tag} BAD Internal server error\r\n`);
    }
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
