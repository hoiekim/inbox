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
import { MailType, Throttler } from "common";
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

type FetchResponsePart =
  | {
      type: "simple";
      content: string;
    }
  | {
      type: "literal";
      content: string;
      header: string;
      length: number;
    };

const throttler = new Throttler();

export class ImapSession {
  public selectedMailbox: string | null = null;
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
      console.log("[IMAP] Attempted to write to destroyed/unwritable socket");
      return false;
    }
    try {
      return this.socket.write(data);
    } catch (error) {
      console.error("[IMAP] Error writing to socket:", error);
      return false;
    }
  };

  isThrottled(): boolean {
    return throttler.isThrottled();
  }

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

    // Check fetch limit
    const requestedCount = this.countSequenceSetMessages(fetchRequest.sequenceSet);
    if (requestedCount > 10) {
      return this.write(`${tag} NO [LIMIT] FETCH too much data requested\r\n`);
    }

    try {
      const messages = await this.fetchMessages(fetchRequest, isUidCommand);
      await this.processFetchMessages(messages, fetchRequest, isUidCommand);
      this.write(`${tag} OK FETCH completed\r\n`);
    } catch (error) {
      console.error("FETCH error", error);
      this.write(`${tag} NO FETCH failed\r\n`);
    }
  };

  private countSequenceSetMessages(sequenceSet: SequenceSet): number {
    let count = 0;
    for (const range of sequenceSet.ranges) {
      if (range.end === undefined) {
        // Single message
        count += 1;
      } else {
        // Range of messages
        count += range.end - range.start + 1;
      }
    }
    return count;
  }

  private async fetchMessages(
    fetchRequest: FetchRequest,
    isUidCommand: boolean
  ) {
    const { start, end } = this.convertSequenceSet(fetchRequest.sequenceSet);
    const requestedFields = this.getRequestedFields(fetchRequest.dataItems);

    return await this.store!.getMessages(
      this.selectedMailbox!,
      start,
      end,
      Array.from(requestedFields),
      fetchRequest.sequenceSet.type === "uid" || isUidCommand
    );
  }

  private async processFetchMessages(
    messages: Map<string, Partial<MailType>>,
    fetchRequest: FetchRequest,
    isUidCommand: boolean
  ) {
    const isDomainInbox = this.selectedMailbox === "INBOX";
    const isUidFetch = fetchRequest.sequenceSet.type === "uid" || isUidCommand;
    const { start } = this.convertSequenceSet(fetchRequest.sequenceSet);
    let i = start - 1;

    for (const [id, mail] of Array.from(messages.entries())) {
      const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
      const seqNum = isUidFetch ? uid : ++i;

      try {
        const response = await this.buildFetchResponse(
          mail,
          fetchRequest.dataItems,
          id,
          uid,
          seqNum,
          isUidFetch
        );
        this.writeFetchResponse(seqNum, response);

        // Mark as read if not using PEEK
        if (checkShouldMarkAsRead(fetchRequest.dataItems)) {
          await markRead(id);
        }
      } catch (error) {
        console.error(`[IMAP] Error processing message ${seqNum}:`, error);
      }
    }
  }

  private async buildFetchResponse(
    mail: Partial<MailType>,
    dataItems: FetchDataItem[],
    docId: string,
    uid: number,
    seqNum: number,
    isUidFetch: boolean
  ): Promise<FetchResponsePart[]> {
    const parts: FetchResponsePart[] = [];

    // Add UID if needed
    if (isUidFetch) {
      parts.push({ type: "simple", content: `UID ${uid}` });
    }

    // Process each data item
    for (const item of dataItems) {
      const part = await this.buildFetchResponsePart(mail, item, docId);
      if (part) {
        parts.push(part);
      }
    }

    return parts;
  }

  private async buildFetchResponsePart(
    mail: Partial<MailType>,
    item: FetchDataItem,
    docId: string
  ): Promise<FetchResponsePart | null> {
    switch (item.type) {
      case "UID":
        const isDomainInbox = this.selectedMailbox === "INBOX";
        const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
        return { type: "simple", content: `UID ${uid}` };

      case "FLAGS":
        const flags = [];
        if (mail.read) flags.push("\\Seen");
        if (mail.saved) flags.push("\\Flagged");
        return { type: "simple", content: `FLAGS (${flags.join(" ")})` };

      case "INTERNALDATE":
        const date = mail.date ? new Date(mail.date) : new Date();
        const internalDate = date.toUTCString().replace(/GMT$/, "+0000");
        return { type: "simple", content: `INTERNALDATE "${internalDate}"` };

      case "RFC822.SIZE":
        const textSize = mail.text ? mail.text.length : 0;
        const htmlSize = mail.html ? mail.html.length : 0;
        const size = textSize + htmlSize;
        return { type: "simple", content: `RFC822.SIZE ${size}` };

      case "ENVELOPE":
        const envelope = this.buildEnvelope(mail);
        return { type: "simple", content: `ENVELOPE ${envelope}` };

      case "BODYSTRUCTURE":
        const bodyStructure = formatBodyStructure(mail);
        return { type: "simple", content: `BODYSTRUCTURE ${bodyStructure}` };

      case "BODY":
        return await this.buildBodyResponsePart(mail, item, docId);

      default:
        return null;
    }
  }

  private async buildBodyResponsePart(
    mail: Partial<MailType>,
    bodyFetch: BodyFetch,
    docId: string
  ): Promise<FetchResponsePart | null> {
    const content = this.getBodyContent(mail, bodyFetch.section, docId);
    if (content === null) {
      return null;
    }

    let finalContent = content;
    let length = Buffer.byteLength(finalContent, "utf8");

    // Apply partial fetch if specified
    if (bodyFetch.partial) {
      finalContent = applyPartialFetch(content, bodyFetch.partial);
      if (finalContent === "" || bodyFetch.partial.start >= length) {
        const sectionKey = getBodySectionKey(bodyFetch.section);
        return { type: "simple", content: `${sectionKey} NIL` };
      }
      length = Buffer.byteLength(finalContent, "utf8");
      finalContent += "\r\n";
    }

    const sectionKey = getBodySectionKey(bodyFetch.section);
    let header = sectionKey;
    if (bodyFetch.partial) {
      header += `<${bodyFetch.partial.start}>`;
    }

    return { type: "literal", content: finalContent, header, length };
  }

  private writeFetchResponse(seqNum: number, parts: FetchResponsePart[]) {
    this.write(`* ${seqNum} FETCH (`);

    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.write(" ");

      const part = parts[i];
      if (part.type === "literal") {
        this.write(`${part.header} {${part.length}}\r\n${part.content}`);
      } else {
        this.write(part.content);
      }
    }

    this.write(")\r\n");
  }

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

        case "INTERNALDATE":
          fields.add("date");
          break;

        case "RFC822.SIZE":
          fields.add("text");
          fields.add("html");
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
        fields.add("html");
        fields.add("attachments");
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

  private getBodyContent(
    mail: Partial<MailType>,
    section: BodySection,
    docId: string
  ): string | null {
    switch (section.type) {
      case "FULL":
        return buildFullMessage(mail, docId);

      case "TEXT":
        // For multipart messages, TEXT should return the body after headers
        const hasText = mail.text && mail.text.trim().length > 0;
        const hasHtml = mail.html && mail.html.trim().length > 0;
        const hasAttachments = mail.attachments && mail.attachments.length > 0;

        // If it's a multipart message, build the multipart body
        if ((hasText && hasHtml) || hasAttachments) {
          const fullMessage = buildFullMessage(mail, docId);
          // Extract body part after headers (after first \r\n\r\n)
          const headerEndIndex = fullMessage.indexOf("\r\n\r\n");
          if (headerEndIndex !== -1) {
            return fullMessage.substring(headerEndIndex + 4);
          }
        }

        // For simple messages, return just the text content
        return mail.text || "";

      case "HEADER":
        return formatHeaders(mail, docId);

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
    if (mechanism !== "PLAIN") {
      return this.write(`${tag} NO Only PLAIN authentication supported\r\n`);
    }

    if (!initialResponse) {
      return this.write(`${tag} BAD Missing initial response\r\n`);
    }

    try {
      // Decode base64 initial response
      const decoded = Buffer.from(initialResponse, "base64").toString("utf8");
      const parts = decoded.split("\0"); // PLAIN format: \0username\0password

      if (parts.length !== 3) {
        return this.write(`${tag} BAD Invalid PLAIN response format\r\n`);
      }

      const [, username, password] = parts;

      // Use the same authentication logic as login
      const inputUser = { username, password };
      const user = await getUser(inputUser);
      const signedUser = user?.getSigned();

      if (!password || !user || !signedUser) {
        this.authenticated = false;
        return this.write(
          `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`
        );
      }

      const pwMatches = await bcrypt.compare(password, user.password as string);

      if (!pwMatches) {
        this.authenticated = false;
        return this.write(
          `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`
        );
      }

      this.store = new Store(signedUser);
      this.authenticated = true;

      this.write(
        `${tag} OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN] AUTHENTICATE completed\r\n`
      );
    } catch (error) {
      console.error("[IMAP] AUTHENTICATE error:", error);
      this.write(`${tag} BAD AUTHENTICATE failed\r\n`);
    }
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
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    try {
      const countResult = await this.store.countMessages(mailbox);

      if (countResult === null) {
        return this.write(`${tag} NO Mailbox does not exist\r\n`);
      }

      const { total, unread } = countResult;

      // Build STATUS response
      let statusItems: string[] = [];

      items.forEach((item) => {
        switch (item) {
          case "MESSAGES":
            statusItems.push("MESSAGES", total.toString());
            break;
          case "UIDNEXT":
            statusItems.push("UIDNEXT", (total + 1).toString());
            break;
          case "UIDVALIDITY":
            statusItems.push("UIDVALIDITY", "1");
            break;
          case "UNSEEN":
            statusItems.push("UNSEEN", unread.toString());
            break;
          case "RECENT":
            statusItems.push("RECENT", "0");
            break;
        }
      });

      this.write(`* STATUS "${mailbox}" (${statusItems.join(" ")})\r\n`);
      this.write(`${tag} OK STATUS completed\r\n`);
    } catch (error) {
      console.error("[IMAP] Error getting mailbox status:", error);
      this.write(`${tag} NO STATUS failed\r\n`);
    }
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
        const response = `* LIST (\\HasNoChildren) "/" "${box}"\r\n`;
        this.write(response);
      });
      this.write(`${tag} OK LIST completed\r\n`);
    } catch (error) {
      console.error("[IMAP] Error listing mailboxes:", error);
      this.write(`${tag} NO LIST failed\r\n`);
    }
  };

  listSubscribedMailboxes = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    try {
      const boxes = await this.store.listMailboxes();
      boxes.forEach((box) => {
        const response = `* LSUB (\\HasNoChildren) "/" "${box}"\r\n`;
        this.write(response);
      });
      this.write(`${tag} OK LSUB completed\r\n`);
    } catch (error) {
      console.error("[IMAP] Error listing subscribed mailboxes:", error);
      this.write(`${tag} NO LSUB failed\r\n`);
    }
  };

  selectMailbox = async (tag: string, name: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    // Remove quotes if present
    const cleanName = name.replace(/^"(.*)"$/, "$1");

    if (!cleanName) {
      return this.write(`${tag} NO Empty mailbox name\r\n`);
    }

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
      console.error("[IMAP] Error selecting mailbox:", error);
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
