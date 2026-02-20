import bcrypt from "bcryptjs";
import { Socket } from "net";
import { TLSSocket } from "tls";
import { readFileSync } from "fs";
import { MailType, Throttler } from "common";
import { getUser, markRead, getDomainUidNext, getAccountUidNext } from "server";
import { Store } from "./store";
import {
  boxToAccount,
  encodeText,
  formatAddressList,
  formatBodyStructure,
  formatFlags,
  formatHeaders,
  formatInternalDate
} from "./util";
import {
  applyPartialFetch,
  getBodySectionKey,
  shouldMarkAsRead as checkShouldMarkAsRead,
  buildFullMessage,
  getBodyPart
} from "./session-utils";
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
import { getCapabilities } from "./capabilities";
import { ImapRequestHandler } from "./handler";

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
  
  // Sequence number mapping: index 0 = seq 1, index 1 = seq 2, etc.
  // Value is the UID for that sequence number
  private seqToUid: number[] = [];
  // Reverse mapping: UID -> sequence number
  private uidToSeq: Map<number, number> = new Map();

  constructor(
    private handler: ImapRequestHandler,
    public socket: Socket
  ) {
    this.sessionId = `session_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
  }

  getCapabilities = () => {
    return getCapabilities(this.handler.port);
  };

  /**
   * Build sequence number → UID mapping for the selected mailbox.
   * Per RFC 3501, sequence numbers must be contiguous 1..N.
   */
  private async buildSequenceMapping(): Promise<void> {
    if (!this.store || !this.selectedMailbox) {
      this.seqToUid = [];
      this.uidToSeq.clear();
      return;
    }

    const uids = await this.store.getAllUids(this.selectedMailbox);
    this.seqToUid = uids;
    this.uidToSeq.clear();
    for (let i = 0; i < uids.length; i++) {
      this.uidToSeq.set(uids[i], i + 1); // seq numbers are 1-indexed
    }
  }

  /**
   * Convert a sequence number to UID.
   * Handles '*' (represented as MAX_SAFE_INTEGER) by returning the highest UID.
   */
  private seqToUidNumber(seq: number): number | undefined {
    // Handle '*' which means "highest sequence number"
    if (seq === Number.MAX_SAFE_INTEGER) {
      return this.seqToUid[this.seqToUid.length - 1];
    }
    return this.seqToUid[seq - 1]; // seq is 1-indexed, array is 0-indexed
  }

  /**
   * Convert a UID to sequence number.
   * Handles '*' (represented as MAX_SAFE_INTEGER) by returning the highest sequence number.
   */
  private uidToSeqNumber(uid: number): number | undefined {
    // Handle '*' which means "highest UID" -> return highest seq
    if (uid === Number.MAX_SAFE_INTEGER) {
      return this.seqToUid.length;
    }
    return this.uidToSeq.get(uid);
  }

  /**
   * Get the total number of messages (highest sequence number).
   */
  private getMessageCount(): number {
    return this.seqToUid.length;
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
      `* CAPABILITY ${this.getCapabilities()}\r\n${tag} OK CAPABILITY completed\r\n`
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
    const requestedCount = this.countSequenceSetMessages(
      fetchRequest.sequenceSet
    );
    if (requestedCount > 50) {
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
    const ranges = this.convertSequenceSet(fetchRequest.sequenceSet);
    const requestedFields = this.getRequestedFields(fetchRequest.dataItems);
    const isUidFetch = fetchRequest.sequenceSet.type === "uid" || isUidCommand;

    const result = new Map<string, Partial<MailType>>();

    await Promise.all(
      ranges.flatMap(async ({ start, end }) => {
        // Convert sequence numbers to UIDs if needed
        let uidStart = start;
        let uidEnd = end;
        
        if (!isUidFetch) {
          // Convert sequence range to UID range
          const startUid = this.seqToUidNumber(start);
          const endUid = this.seqToUidNumber(end);
          if (startUid === undefined || endUid === undefined) {
            console.warn(`[IMAP] Invalid sequence range ${start}-${end}`);
            return;
          }
          uidStart = startUid;
          uidEnd = endUid;
        }
        
        // Always fetch by UID from the store for consistency
        const messages = await this.store!.getMessages(
          this.selectedMailbox!,
          uidStart,
          uidEnd,
          Array.from(requestedFields),
          true // Always use UID for database queries
        );
        messages.forEach((mail, id) => {
          result.set(id, mail);
        });
      })
    );

    return result;
  }

  private async processFetchMessages(
    messages: Map<string, Partial<MailType>>,
    fetchRequest: FetchRequest,
    isUidCommand: boolean
  ) {
    const isDomainInbox = this.selectedMailbox === "INBOX";
    const isUidFetch = fetchRequest.sequenceSet.type === "uid" || isUidCommand;

    for (const [id, mail] of Array.from(messages.entries())) {
      const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
      // Use proper sequence number from mapping (RFC 3501 compliance)
      const seqNum = this.uidToSeqNumber(uid);
      
      if (seqNum === undefined) {
        console.warn(`[IMAP] No sequence number found for UID ${uid}`);
        continue;
      }

      try {
        const response = await this.buildFetchResponse(
          mail,
          fetchRequest.dataItems,
          id,
          uid,
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
    isUidFetch: boolean
  ): Promise<FetchResponsePart[]> {
    const parts: FetchResponsePart[] = [];

    // Add UID if needed
    if (isUidFetch) {
      parts.push({ type: "simple", content: `UID ${uid}` });
    }

    // Process each data item
    for (const item of dataItems) {
      // Skip duplicate UID
      if (item.type === "UID" && isUidFetch) continue;
      const part = await this.buildFetchResponsePart(mail, item, docId);
      if (part) parts.push(part);
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
        const flags = formatFlags(mail);
        return { type: "simple", content: `FLAGS (${flags.join(" ")})` };

      case "INTERNALDATE":
        const date = mail.date ? new Date(mail.date) : new Date();
        const internalDate = formatInternalDate(date);
        return { type: "simple", content: `INTERNALDATE "${internalDate}"` };

      case "RFC822.SIZE":
        const encodedText = encodeText(mail.text || "");
        const textSize = Buffer.byteLength(encodedText, "utf-8");
        const encodedHtml = encodeText(mail.html || "");
        const htmlSize = Buffer.byteLength(encodedHtml, "utf-8");
        const attachmentSize = (mail.attachments ?? []).reduce(
          (acc, { size }) => acc + Math.ceil(size / 3) * 4,
          0
        );
        const size = textSize + htmlSize + attachmentSize;
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
    const { section, partial } = bodyFetch;

    const content = this.getBodyContent(mail, section, docId);
    if (content === null) {
      return null;
    }

    const sectionKey = getBodySectionKey(section);
    let header = sectionKey;
    let finalContent = content;
    let length = Buffer.byteLength(finalContent, "utf8");

    if (finalContent === "" || (partial && partial.start >= length)) {
      const sectionKey = getBodySectionKey(section);
      return { type: "simple", content: `${sectionKey} NIL` };
    }

    // Apply partial fetch if specified
    if (partial) {
      const { start, length: partialLength } = partial;
      const end = start + partialLength;
      if (0 < start || end < length) {
        finalContent = applyPartialFetch(content, partial);
        length = Buffer.byteLength(finalContent, "utf8");
      }
      header += `<${start}.${Math.min(partialLength, length)}>`;
      finalContent += "\r\n";
    } else if (section.type !== "HEADER") {
      finalContent += "\r\n";
      length = Buffer.byteLength(finalContent, "utf8");
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
  }[] {
    return sequenceSet.ranges.map(({ start, end = start }) => {
      return { start, end };
    });
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
          fields.add("deleted");
          fields.add("draft");
          break;

        case "BODYSTRUCTURE":
          fields.add("text");
          fields.add("html");
          fields.add("attachments");
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
          fields.add("attachments");
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
        fields.add("attachments");
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
        return formatHeaders(mail, docId) + "\r\n";

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
        `${tag} OK [CAPABILITY ${this.getCapabilities()}] AUTHENTICATE completed\r\n`
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

    if (!searchRequest.criteria.length) {
      return this.write(`${tag} BAD Search criteria is required\r\n`);
    }

    const hasUidCriteria = searchRequest.criteria.some((c) => c.type === "UID");

    if (!isUidCommand && hasUidCriteria) {
      return this.write(`${tag} NO Not supported\r\n`);
    }

    try {
      // Store.search returns UIDs
      const uids = await this.store.search(
        this.selectedMailbox,
        searchRequest.criteria
      );
      
      // For UID SEARCH: return UIDs directly
      // For SEARCH: convert UIDs to sequence numbers (RFC 3501)
      let result: number[];
      if (isUidCommand) {
        result = uids;
      } else {
        result = uids
          .map((uid) => this.uidToSeqNumber(uid))
          .filter((seq): seq is number => seq !== undefined);
      }
      
      this.write(`* SEARCH ${result.join(" ")}\r\n`);
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

    // Determine if we're working with UIDs or sequence numbers
    const isUidStore = storeRequest.sequenceSet.type === "uid" || isUidCommand;

    try {
      const { sequenceSet, operation, flags, silent } = storeRequest;
      const ranges = this.convertSequenceSet(sequenceSet);

      for (const { start, end } of ranges) {
        // Convert sequence numbers to UIDs if needed
        let uidStart = start;
        let uidEnd = end;
        
        if (!isUidStore) {
          // Convert sequence numbers to UIDs for the store operation
          const startUid = this.seqToUidNumber(start);
          const endUid = this.seqToUidNumber(end);
          if (startUid === undefined || endUid === undefined) {
            console.warn(`[IMAP] Invalid sequence range ${start}-${end}`);
            continue;
          }
          uidStart = startUid;
          uidEnd = endUid;
        }
        
        const updated = await this.store!.setFlags(
          this.selectedMailbox!,
          uidStart,
          uidEnd,
          flags,
          true // Always use UID for database operations
        );

        if (!updated) {
          this.write(`${tag} NO STORE failed\r\n`);
          throw new Error(
            `STORE failed for range ${start}-${end} in mailbox ${this.selectedMailbox}`
          );
        } else {
          // Send untagged response unless silent
          // Response always uses sequence numbers per RFC 3501
          if (!silent && !operation.includes("SILENT")) {
            for (let uid = uidStart; uid <= uidEnd; uid++) {
              const seq = this.uidToSeqNumber(uid);
              if (seq !== undefined) {
                this.write(`* ${seq} FETCH (FLAGS (${flags.join(" ")}))\r\n`);
              }
            }
          }
        }
      }

      this.write(`${tag} OK STORE completed\r\n`);
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
      const domainUid = await getDomainUidNext(user.id);
      const accountUid = await getAccountUidNext(user.id, account);
      mail.uid.domain = domainUid || 1;
      mail.uid.account = accountUid || 1;

      // Store the message in PostgreSQL
      const result = await this.store.storeMail(mail);

      let uid: number;
      if (appendRequest.mailbox === "INBOX") uid = mail.uid.domain;
      else uid = mail.uid.account;

      if (result) {
        // If appending to the currently selected mailbox, update sequence mapping
        if (this.selectedMailbox === appendRequest.mailbox) {
          await this.buildSequenceMapping();
        }
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
      `${tag} OK [CAPABILITY ${this.getCapabilities()}] LOGIN completed\r\n`
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
      
      // Build sequence number mapping for this mailbox
      await this.buildSequenceMapping();
      
      const countResult = await this.store.countMessages(cleanName);

      if (countResult === null) {
        this.selectedMailbox = null;
        this.seqToUid = [];
        this.uidToSeq.clear();
        return this.write(`${tag} NO Mailbox does not exist\r\n`);
      }

      const { total, unread } = countResult;

      this.write(`* ${total} EXISTS\r\n`);
      this.write(`* 0 RECENT\r\n`);
      this.write(
        `* OK [UNSEEN ${unread}] Message ${unread} is first unseen\r\n`
      );
      // TODO: Implement per-mailbox UIDVALIDITY tracking
      this.write(`* OK [UIDVALIDITY 1] UIDs valid\r\n`);
      this.write(`* OK [UIDNEXT ${total + 1}] Predicted next UID\r\n`);
      this.write(`* FLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered)\r\n`);
      this.write(`* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered \\*)] Flags permitted\r\n`);
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
      const expungedUids = await this.store.expunge(this.selectedMailbox);
      
      // Convert UIDs to sequence numbers BEFORE modifying the mapping.
      // Per RFC 3501, EXPUNGE responses must use the sequence number
      // the message had BEFORE any previous EXPUNGE in this response.
      // We process in reverse order so sequence numbers remain valid.
      const seqNumbers: number[] = [];
      for (const uid of expungedUids) {
        const seq = this.uidToSeqNumber(uid);
        if (seq !== undefined) {
          seqNumbers.push(seq);
        }
      }
      
      // Sort descending - we must report higher seq numbers first
      // because each EXPUNGE shifts subsequent sequence numbers down
      seqNumbers.sort((a, b) => b - a);
      
      for (const seq of seqNumbers) {
        this.write(`* ${seq} EXPUNGE\r\n`);
      }
      
      // Rebuild the sequence mapping after expunge
      await this.buildSequenceMapping();
      
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

    // Clear the selected mailbox and sequence mapping
    this.selectedMailbox = null;
    this.seqToUid = [];
    this.uidToSeq.clear();
    this.write(`${tag} OK CLOSE completed\r\n`);
  };

  logout = async (tag: string) => {
    // End IDLE if active
    if (this.isIdling) {
      this.endIdle();
    }

    this.store = null;
    this.selectedMailbox = null;
    this.seqToUid = [];
    this.uidToSeq.clear();
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

  startTls = async (tag: string) => {
    const { SSL_CERTIFICATE = "", SSL_CERTIFICATE_KEY = "" } = process.env;

    const secureSocket = await new Promise<Socket>((resolve, reject) => {
      const secureSocket = new TLSSocket(this.socket, {
        isServer: true,
        key: readFileSync(SSL_CERTIFICATE_KEY),
        cert: readFileSync(SSL_CERTIFICATE)
      });

      secureSocket.once("secure", () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });

    this.socket = secureSocket;
    this.handler.setSocket(secureSocket);

    this.write(`${tag} OK Begin TLS negotiation now\r\n`);
  };
}
