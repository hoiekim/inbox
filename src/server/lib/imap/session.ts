import bcrypt from "bcrypt";
import { Socket } from "net";
import { Store } from "./store";
import { getUser, markRead, getDomainUidNext, getAccountUidNext } from "server";
import {
  boxToAccount,
  formatAddressList,
  formatBodyStructure,
  formatHeaders
} from "./util";
import {
  applyPartialFetch,
  getBodySectionKey,
  shouldMarkAsRead as checkShouldMarkAsRead,
  buildFullMessage,
  getBodyPart
} from "./session-utils";
import { MailType } from "common";
import {
  FetchRequest,
  FetchDataItem,
  BodyFetch,
  BodySection,
  SequenceSet,
  SearchRequest,
  StoreRequest,
  CopyRequest,
  AppendRequest,
  StatusItem
} from "./types";
import { idleManager } from "./idle-manager";

export class ImapSession {
  private selectedMailbox: string | null = null;
  private store: Store | null = null;
  private authenticated: boolean = false;
  private isIdling: boolean = false;
  private idleTag: string | null = null;
  private sessionId: string;

  constructor(private socket: Socket) {
    this.sessionId = `session_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
  }

  write = (data: string) => {
    if (this.socket.destroyed || !this.socket.writable) {
      return false;
    }
    return this.socket.write(data);
  };

  // New typed command handlers
  capability = (tag: string) => {
    this.write(
      `* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`
    );
  };

  noop = (tag: string) => {
    this.write(`${tag} OK NOOP completed\r\n`);
  };

  examineMailbox = async (tag: string, name: string) => {
    // EXAMINE is like SELECT but read-only - for now, treat the same
    return this.selectMailbox(tag, name);
  };

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

    try {
      // Convert sequence set to start/end range
      const { start, end } = this.convertSequenceSet(fetchRequest.sequenceSet);

      // Determine required fields based on data items
      const requestedFields = this.getRequestedFields(fetchRequest.dataItems);

      // Fetch messages from store
      const messages = await this.store.getMessages(
        this.selectedMailbox,
        start,
        end,
        Array.from(requestedFields),
        fetchRequest.sequenceSet.type === "uid" || isUidCommand
      );

      const isDomainInbox = this.selectedMailbox === "INBOX";
      const isUidFetch =
        fetchRequest.sequenceSet.type === "uid" || isUidCommand;
      let i = start - 1;

      // Process each message
      const iterator = messages.entries();
      let current = iterator.next();

      while (!current.done) {
        const [id, mail] = current.value;
        const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
        const seqNum = isUidFetch ? uid : ++i;

        // Build response parts
        const parts = await this.buildFetchResponseParts(
          mail,
          fetchRequest.dataItems
        );

        // Write response
        this.write(`* ${seqNum} FETCH (${parts.join(" ")})\r\n`);

        // Mark as read if not using PEEK
        const shouldMarkAsRead = checkShouldMarkAsRead(fetchRequest.dataItems);
        if (shouldMarkAsRead) {
          await markRead(id);
        }

        current = iterator.next();
      }

      this.write(`${tag} OK FETCH completed\r\n`);
    } catch (error) {
      console.error("FETCH error", error);
      this.write(`${tag} NO FETCH failed\r\n`);
    }
  };

  // Helper methods for typed FETCH
  private convertSequenceSet(sequenceSet: SequenceSet): {
    start: number;
    end: number;
  } {
    // For simplicity, take the first range - TODO: Handle multiple ranges properly
    const firstRange = sequenceSet.ranges[0];
    return {
      start: firstRange.start,
      end: firstRange.end || firstRange.start
    };
  }

  private getRequestedFields(dataItems: FetchDataItem[]): Set<keyof MailType> {
    const fields = new Set<keyof MailType>(["uid"]);

    for (const item of dataItems) {
      switch (item.type) {
        case "ENVELOPE":
          fields.add("subject");
          fields.add("from");
          fields.add("to");
          fields.add("cc");
          fields.add("bcc");
          fields.add("date");
          fields.add("messageId");
          break;

        case "FLAGS":
          fields.add("read");
          fields.add("saved");
          break;

        case "BODYSTRUCTURE":
          fields.add("attachments");
          fields.add("text");
          fields.add("html");
          break;

        case "BODY":
          this.addBodyFields(item, fields);
          break;
      }
    }

    return fields;
  }

  private addBodyFields(
    bodyFetch: BodyFetch,
    fields: Set<keyof MailType>
  ): void {
    switch (bodyFetch.section.type) {
      case "FULL":
        fields.add("text");
        fields.add("html");
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("date");
        fields.add("messageId");
        break;

      case "TEXT":
        fields.add("text");
        break;

      case "HEADER":
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("date");
        fields.add("messageId");
        break;

      case "MIME_PART":
        fields.add("text");
        fields.add("html");
        fields.add("attachments");
        break;
    }
  }

  private async buildFetchResponseParts(
    mail: Partial<MailType>,
    dataItems: FetchDataItem[]
  ): Promise<string[]> {
    const parts: string[] = [];

    for (const item of dataItems) {
      switch (item.type) {
        case "UID":
          const uid = mail.uid!.domain || mail.uid!.account;
          parts.push(`UID ${uid}`);
          break;

        case "FLAGS":
          const flags = [];
          if (mail.read) flags.push("\\Seen");
          if (mail.saved) flags.push("\\Flagged");
          parts.push(`FLAGS (${flags.join(" ")})`);
          break;

        case "ENVELOPE":
          const envelope = this.buildEnvelope(mail);
          parts.push(`ENVELOPE ${envelope}`);
          break;

        case "BODYSTRUCTURE":
          const bodyStructure = formatBodyStructure(mail);
          parts.push(`BODYSTRUCTURE ${bodyStructure}`);
          break;

        case "BODY":
          const bodyPart = await this.buildBodyPart(mail, item);
          if (bodyPart) {
            parts.push(bodyPart);
          }
          break;
      }
    }

    return parts;
  }

  private buildEnvelope(mail: Partial<MailType>): string {
    const dateString = new Date(mail.date!).toUTCString();
    const subject = (mail.subject || "").replace(/"/g, '\\"');
    const from = formatAddressList(mail.from?.value);
    const to = formatAddressList(mail.to?.value);
    const cc = formatAddressList(mail.cc?.value);
    const bcc = formatAddressList(mail.bcc?.value);
    const messageId = mail.messageId || "<unknown@local>";

    return `("${dateString}" "${subject}" NIL NIL NIL (${from}) (${to}) (${cc}) (${bcc}) NIL "${messageId}")`;
  }

  private async buildBodyPart(
    mail: Partial<MailType>,
    bodyFetch: BodyFetch
  ): Promise<string | null> {
    let content = this.getBodyContent(mail, bodyFetch.section);
    if (content === null) {
      return null;
    }

    // Apply partial fetch if specified
    if (bodyFetch.partial) {
      content = applyPartialFetch(content, bodyFetch.partial);
    }

    const length = Buffer.byteLength(content, "utf8");
    const sectionKey = getBodySectionKey(bodyFetch.section);

    return `${sectionKey} {${length}}\r\n${content}`;
  }

  private getBodyContent(
    mail: Partial<MailType>,
    section: BodySection
  ): string | null {
    switch (section.type) {
      case "FULL":
        return buildFullMessage(mail);

      case "TEXT":
        return mail.text || "";

      case "HEADER":
        return formatHeaders(mail);

      case "MIME_PART":
        return getBodyPart(mail, section.partNumber);

      default:
        return null;
    }
  }

  // Additional command handlers for complete IMAP support
  authenticate = async (
    tag: string,
    mechanism: string,
    initialResponse?: string
  ) => {
    // Basic AUTHENTICATE implementation - for now just reject
    this.write(`${tag} NO AUTHENTICATE not supported\r\n`);
  };

  createMailbox = async (tag: string, mailbox: string) => {
    this.write(`${tag} NO CREATE not supported\r\n`);
  };

  deleteMailbox = async (tag: string, mailbox: string) => {
    this.write(`${tag} NO DELETE not supported\r\n`);
  };

  renameMailbox = async (tag: string, oldName: string, newName: string) => {
    this.write(`${tag} NO RENAME not supported\r\n`);
  };

  subscribeMailbox = async (tag: string, mailbox: string) => {
    this.write(`${tag} OK SUBSCRIBE completed\r\n`);
  };

  unsubscribeMailbox = async (tag: string, mailbox: string) => {
    this.write(`${tag} OK UNSUBSCRIBE completed\r\n`);
  };

  statusMailbox = async (tag: string, mailbox: string, items: StatusItem[]) => {
    this.write(`${tag} OK STATUS completed\r\n`);
  };

  check = async (tag: string) => {
    this.write(`${tag} OK CHECK completed\r\n`);
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

    if (!searchRequest.charset) {
      return this.write(`${tag} BAD \r\n`);
    }

    try {
      const result = await this.store.search(
        this.selectedMailbox,
        [searchRequest.charset],
        isUidCommand
      );
      const resultType = isUidCommand ? "UID SEARCH" : "SEARCH";
      this.write(`* ${resultType} ${result.join(" ")}\r\n`);
      this.write(`${tag} OK SEARCH completed\r\n`);
    } catch (error) {
      console.error("Search failed:", error);
      this.write(`${tag} NO SEARCH failed\r\n`);
    }
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

    try {
      const { sequenceSet, operation, flags, silent } = storeRequest;
      const { start } = this.convertSequenceSet(sequenceSet);

      // Use UID-based lookup if this is a UID command or sequence set is UID-based
      const useUid = isUidCommand || sequenceSet.type === "uid";
      const updated = await this.store.setFlags(
        this.selectedMailbox,
        start,
        flags,
        useUid
      );

      if (!updated) {
        this.write(`${tag} NO STORE failed\r\n`);
      } else {
        // Send untagged response unless silent
        if (!silent && !operation.includes("SILENT")) {
          const responseNum = useUid ? start : start; // In real implementation, convert UID to sequence number
          this.write(`* ${responseNum} FETCH (FLAGS (${flags.join(" ")}))\r\n`);
        }
        this.write(`${tag} OK STORE completed\r\n`);
      }
    } catch (error) {
      console.error("Error storing flags:", error);
      this.write(`${tag} NO STORE failed\r\n`);
    }
  };

  copyMessageTyped = async (
    tag: string,
    copyRequest: CopyRequest,
    isUidCommand: boolean = false
  ) => {
    // Reject all COPY operations - we don't want clients moving messages around
    this.write(`${tag} NO [CANNOT] COPY not permitted\r\n`);
  };

  /**
   * Handle APPEND command - add a message to a mailbox
   */
  appendMessage = async (tag: string, appendRequest: AppendRequest) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    try {
      // Parse the message to extract headers and content
      const messageLines = appendRequest.message.split("\r\n");
      let headerEndIndex = messageLines.findIndex((line) => line === "");
      if (headerEndIndex === -1) headerEndIndex = messageLines.length;

      const headers = messageLines.slice(0, headerEndIndex).join("\r\n");
      const body = messageLines.slice(headerEndIndex + 1).join("\r\n");

      // Parse basic headers
      const subjectMatch = headers.match(/^Subject:\s*(.*)$/im);
      const fromMatch = headers.match(/^From:\s*(.*)$/im);
      const toMatch = headers.match(/^To:\s*(.*)$/im);
      const dateMatch = headers.match(/^Date:\s*(.*)$/im);
      const messageIdMatch = headers.match(/^Message-ID:\s*(.*)$/im);

      // Create a new Mail instance
      const mail = new (await import("common")).Mail();

      // Set basic properties
      mail.subject = subjectMatch ? subjectMatch[1].trim() : "";
      mail.text = body; // For simplicity, treating body as text
      mail.html = body.includes("<") ? body : ""; // Basic HTML detection
      mail.date = dateMatch
        ? new Date(dateMatch[1]).toISOString()
        : new Date().toISOString();
      mail.messageId = messageIdMatch
        ? messageIdMatch[1].trim().replace(/[<>]/g, "")
        : mail.messageId;

      // Set flags
      mail.draft = true; // APPEND messages are typically drafts
      mail.read = false;
      mail.saved = appendRequest.flags?.includes("\\Flagged") || false;

      // Parse addresses (basic parsing)
      if (fromMatch) {
        mail.from = {
          value: [{ address: fromMatch[1].trim(), name: "" }],
          text: fromMatch[1].trim()
        };
      }
      if (toMatch) {
        mail.to = {
          value: [{ address: toMatch[1].trim(), name: "" }],
          text: toMatch[1].trim()
        };
      }

      // Get next UID and set envelope addresses
      const user = this.store.getUser();
      const account = boxToAccount(user.username, appendRequest.mailbox);
      const domainUid = await getDomainUidNext(user);
      const accountUid = await getAccountUidNext(user, account);
      mail.uid.domain = domainUid || 1;
      mail.uid.account = accountUid || 1;

      // Store the message in Elasticsearch
      const result = await this.store.storeMail(mail);

      let uid: number;
      if (appendRequest.mailbox === "INBOX") uid = mail.uid.domain;
      else uid = mail.uid.account;

      if (result) {
        // Return success with the new UID
        this.write(
          `${tag} OK [APPENDUID ${Date.now()} ${uid}] APPEND completed\r\n`
        );
      } else {
        this.write(`${tag} NO APPEND failed to store message\r\n`);
      }
    } catch (error) {
      console.error("APPEND error:", error);
      this.write(`${tag} NO APPEND failed\r\n`);
    }
  };

  login = async (tag: string, args: string[]) => {
    if (args.length < 2) {
      return this.write(`${tag} BAD LOGIN requires username and password\r\n`);
    }

    const [username, password] = args;

    // Remove quotes if present
    const cleanUsername = username.replace(/^"(.*)"$/, "$1");
    const cleanPassword = password.replace(/^"(.*)"$/, "$1");

    const inputUser = { username: cleanUsername, password: cleanPassword };
    const user = await getUser(inputUser);
    const signedUser = user?.getSigned();

    if (!inputUser.password || !user || !signedUser) {
      return this.write(
        `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`
      );
    }

    const pwMatches = await bcrypt.compare(
      inputUser.password,
      user.password as string
    );

    if (!pwMatches) {
      return this.write(
        `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`
      );
    }

    this.store = new Store(signedUser);
    this.authenticated = true;

    return this.write(
      `${tag} OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN] LOGIN completed\r\n`
    );
  };

  listMailboxes = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    try {
      const boxes = await this.store.listMailboxes();
      boxes.forEach((box) => {
        this.write(`* LIST (\\HasNoChildren) "/" "${box}"\r\n`);
      });
      this.write(`${tag} OK LIST completed\r\n`);
    } catch (error) {
      console.error("Error listing mailboxes:", error);
      this.write(`${tag} NO LIST failed\r\n`);
    }
  };

  selectMailbox = async (tag: string, name: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    // Remove quotes if present
    const cleanName = name.replace(/^"(.*)"$/, "$1");

    try {
      this.selectedMailbox = cleanName;
      const countResult = await this.store.countMessages(cleanName);

      if (countResult === null) {
        this.selectedMailbox = null;
        return this.write(`${tag} NO Mailbox does not exist\r\n`);
      }

      const { total, unread } = countResult;

      this.write(`* ${total} EXISTS\r\n`);
      this.write(
        `* OK [UNSEEN ${unread}] Message ${unread} is first unseen\r\n`
      );
      this.write(`* OK [UIDVALIDITY 1] UIDs valid\r\n`);
      this.write(`* OK [UIDNEXT ${total + 1}] Predicted next UID\r\n`);
      this.write(`* FLAGS (\\Flagged \\Seen)\r\n`);
      this.write(`* OK [PERMANENTFLAGS (\\Flagged \\Seen)] Limited\r\n`);
      this.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
    } catch (error) {
      console.error("Error selecting mailbox:", error);
      this.write(`${tag} NO SELECT failed\r\n`);
    }
  };

  expunge = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    try {
      await this.store.expunge(this.selectedMailbox);
      this.write(`${tag} OK EXPUNGE completed\r\n`);
    } catch (error) {
      console.error("Expunge failed:", error);
      this.write(`${tag} NO EXPUNGE failed\r\n`);
    }
  };

  closeMailbox = (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    // Clear the selected mailbox
    this.selectedMailbox = null;
    this.write(`${tag} OK CLOSE completed\r\n`);
  };

  logout = async (tag: string) => {
    // End IDLE if active
    if (this.isIdling) {
      this.endIdle();
    }

    this.store = null;
    this.selectedMailbox = null;
    this.authenticated = false;
    this.write("* BYE IMAP4rev1 Server logging out\r\n");
    this.write(`${tag} OK LOGOUT completed\r\n`);
    this.socket.end();
  };

  /**
   * Start IDLE mode for real-time notifications
   */
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

    // Register with IDLE manager
    const user = this.store.getUser();
    idleManager.addIdleSession(
      this.sessionId,
      this,
      tag,
      this.selectedMailbox,
      user.username
    );

    // Send continuation response
    this.write("+ idling\r\n");

    // Set up socket listener for DONE command
    this.socket.on("data", this.handleIdleData);
  };

  /**
   * Handle data received during IDLE mode
   */
  private handleIdleData = (data: Buffer) => {
    if (!this.isIdling) return;

    const command = data.toString().trim().toUpperCase();
    if (command === "DONE") {
      this.endIdle();
    }
  };

  /**
   * End IDLE mode
   */
  private endIdle = () => {
    if (!this.isIdling || !this.idleTag) return;

    this.isIdling = false;
    const tag = this.idleTag;
    this.idleTag = null;

    // Remove from IDLE manager
    idleManager.removeIdleSession(this.sessionId);

    // Remove socket listener
    this.socket.off("data", this.handleIdleData);

    // Send completion response
    this.write(`${tag} OK IDLE terminated\r\n`);
  };

  /**
   * Check if session is in IDLE mode
   */
  isInIdleMode = (): boolean => {
    return this.isIdling;
  };

  /**
   * Get session ID
   */
  getSessionId = (): string => {
    return this.sessionId;
  };
}
