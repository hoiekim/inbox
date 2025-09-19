/**
 * IMAP request handler - translates parsed commands to session method calls
 */

import { Socket } from "net";
import { ImapSession } from "./session";
import { ImapRequest } from "./types";
import { parseCommand } from "./parsers";

export class ImapRequestHandler {
  private session: ImapSession | null = null;

  constructor(public port = 143) {}

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

    socket.on("data", async (data) => {
      try {
        buffer += data.toString();

        // Process complete lines
        let lineEnd;
        while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.substring(0, lineEnd);
          buffer = buffer.substring(lineEnd + 2);

          if (line.trim()) {
            console.log(
              `[IMAP] Received: "${line.trim()}"\n\tfor mailbox: ${
                session.selectedMailbox
              }`
            );

            // Check throttling before processing
            if (session.isThrottled()) {
              session.write(
                "* NO [TEMPORARY UNAVAILABLE] Server is busy. Please try again later.\r\n"
              );
              continue;
            }

            try {
              // Parse the command using the typed parser
              const parseResult = parseCommand(line.trim());

              if (parseResult.success && parseResult.value) {
                const { tag, request } = parseResult.value;
                await this.handleRequest(tag, request);
              } else {
                // If parsing failed, send error response only if socket is writable
                console.log(
                  `[PARSER] Parse failed for "${line.trim()}": ${
                    parseResult.error
                  }`
                );
                const parts = line.trim().split(" ");
                const tag = parts[0] || "BAD";
                const errorMsg = parseResult.error || "Invalid command syntax";
                session.write(`${tag} BAD ${errorMsg}\r\n`);
              }
            } catch (error) {
              console.error("Error processing command:", error);
              // Only send error response if socket is still writable
              const parts = line.trim().split(" ");
              const tag = parts[0] || "BAD";
              session.write(`${tag} BAD Internal server error\r\n`);
            }
          }
        }
      } catch (error) {
        console.error("Error processing data:", error);
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
    });

    socket.on("close", () => {
      console.log("IMAP connection closed");
    });

    socket.on("error", (error) => {
      if (!error.message.includes("ECONNRESET")) {
        console.error("IMAP socket error:", error);
      }
      if (!socket.destroyed) {
        socket.destroy();
      }
    });

    // Set socket timeout to prevent hanging connections
    socket.setTimeout(300000); // 5 minutes
    socket.on("timeout", () => {
      console.log("IMAP socket timeout");
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
      console.error("Invalid session: Use setSocket to start a session.");
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
          this.session.write(`${tag} NO APPEND not supported\r\n`);
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

        case "APPEND":
          await this.session.appendMessage(tag, request.data);
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

        default:
          this.session.write(`${tag} BAD Unknown command\r\n`);
          break;
      }
    } catch (error) {
      console.error("Error handling IMAP request:", error);
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
      console.error("Invalid session: Use setSocket to start a session.");
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
      console.error("Error handling UID command:", error);
      this.session.write(`${tag} BAD Internal server error\r\n`);
    }
  }
}
