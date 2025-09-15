/**
 * IMAP request handler - translates parsed commands to session method calls
 */

import { ImapSession } from "./session";
import { ImapRequest } from "./types";

export class ImapRequestHandler {
  constructor(private session: ImapSession) {}

  /**
   * Handle a parsed IMAP request by delegating to appropriate session methods
   */
  async handleRequest(tag: string, request: ImapRequest): Promise<void> {
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
