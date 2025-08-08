import bcrypt from "bcrypt";
import { Socket } from "net";
import { Store } from "./store";
import { getUser, markRead } from "server";
import { formatAddressList, formatBodyStructure, formatHeaders } from "./util";
import { MailType } from "common";
import { FetchRequest, FetchDataItem, BodyFetch, BodySection, PartialRange, SequenceSet, SearchRequest, StoreRequest, CopyRequest, StatusResponseData, StatusItem } from "./types";
import { idleManager } from "./idle-manager";

export class ImapSession {
  private selectedMailbox: string | null = null;
  private store: Store | null = null;
  private authenticated: boolean = false;
  private isIdling: boolean = false;
  private idleTag: string | null = null;
  private sessionId: string;

  constructor(private socket: Socket) {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  write = this.socket.write;

  // New typed command handlers
  capability = (tag: string) => {
    this.write(
      `* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`
    );
  };

  noop = (tag: string) => {
    this.write(`${tag} OK NOOP completed\r\n`);
  };

  examineMailbox = async (tag: string, name: string) => {
    // EXAMINE is like SELECT but read-only - for now, treat the same
    return this.selectMailbox(tag, name);
  };

  fetchMessagesTyped = async (tag: string, fetchRequest: FetchRequest, isUidCommand: boolean = false) => {
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
        fetchRequest.sequenceSet.type === 'uid' || isUidCommand
      );

      const isDomainInbox = this.selectedMailbox === "INBOX";
      const isUidFetch = fetchRequest.sequenceSet.type === 'uid' || isUidCommand;
      let i = start - 1;

      // Process each message
      const iterator = messages.entries();
      let current = iterator.next();

      while (!current.done) {
        const [id, mail] = current.value;
        const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
        const seqNum = isUidFetch ? uid : ++i;

        // Build response parts
        const parts = await this.buildFetchResponseParts(mail, fetchRequest.dataItems, isUidCommand);
        
        // Write response
        this.write(`* ${seqNum} FETCH (${parts.join(" ")})\r\n`);

        // Mark as read if not using PEEK
        const shouldMarkAsRead = this.shouldMarkAsRead(fetchRequest.dataItems);
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
  private convertSequenceSet(sequenceSet: SequenceSet): { start: number; end: number } {
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
        case 'ENVELOPE':
          fields.add("subject");
          fields.add("from");
          fields.add("to");
          fields.add("cc");
          fields.add("bcc");
          fields.add("date");
          fields.add("messageId");
          break;
        
        case 'FLAGS':
          fields.add("read");
          fields.add("saved");
          break;
        
        case 'BODYSTRUCTURE':
          fields.add("attachments");
          fields.add("text");
          fields.add("html");
          break;
        
        case 'BODY':
          this.addBodyFields(item, fields);
          break;
      }
    }

    return fields;
  }

  private addBodyFields(bodyFetch: BodyFetch, fields: Set<keyof MailType>): void {
    switch (bodyFetch.section.type) {
      case 'FULL':
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
      
      case 'TEXT':
        fields.add("text");
        break;
      
      case 'HEADER':
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("date");
        fields.add("messageId");
        break;
      
      case 'MIME_PART':
        fields.add("text");
        fields.add("html");
        fields.add("attachments");
        break;
    }
  }

  private async buildFetchResponseParts(mail: Partial<MailType>, dataItems: FetchDataItem[], isUidCommand: boolean = false): Promise<string[]> {
    const parts: string[] = [];

    for (const item of dataItems) {
      switch (item.type) {
        case 'UID':
          const uid = mail.uid!.domain || mail.uid!.account;
          parts.push(`UID ${uid}`);
          break;
        
        case 'FLAGS':
          const flags = [];
          if (mail.read) flags.push("\\Seen");
          if (mail.saved) flags.push("\\Flagged");
          parts.push(`FLAGS (${flags.join(" ")})`);
          break;
        
        case 'ENVELOPE':
          const envelope = this.buildEnvelope(mail);
          parts.push(`ENVELOPE ${envelope}`);
          break;
        
        case 'BODYSTRUCTURE':
          const bodyStructure = formatBodyStructure(mail);
          parts.push(`BODYSTRUCTURE ${bodyStructure}`);
          break;
        
        case 'BODY':
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

  private async buildBodyPart(mail: Partial<MailType>, bodyFetch: BodyFetch): Promise<string | null> {
    let content = this.getBodyContent(mail, bodyFetch.section);
    if (content === null) {
      return null;
    }

    // Apply partial fetch if specified
    if (bodyFetch.partial) {
      content = this.applyPartialFetch(content, bodyFetch.partial);
    }

    const length = Buffer.byteLength(content, "utf8");
    const sectionKey = this.getBodySectionKey(bodyFetch.section);
    
    return `${sectionKey} {${length}}\r\n${content}`;
  }

  private getBodyContent(mail: Partial<MailType>, section: BodySection): string | null {
    switch (section.type) {
      case 'FULL':
        return this.buildFullMessage(mail);
      
      case 'TEXT':
        return mail.text || "";
      
      case 'HEADER':
        return formatHeaders(mail);
      
      case 'MIME_PART':
        return this.getBodyPart(mail, section.partNumber);
      
      default:
        return null;
    }
  }

  private applyPartialFetch(content: string, partial: PartialRange): string {
    const contentBuffer = Buffer.from(content, "utf8");
    const endPos = Math.min(partial.start + partial.length, contentBuffer.length);
    
    if (partial.start < contentBuffer.length) {
      return contentBuffer.subarray(partial.start, endPos).toString("utf8");
    } else {
      return "";
    }
  }

  private getBodySectionKey(section: BodySection): string {
    switch (section.type) {
      case 'FULL':
        return 'BODY[]';
      case 'TEXT':
        return 'BODY[TEXT]';
      case 'HEADER':
        return 'BODY[HEADER]';
      case 'MIME_PART':
        return `BODY[${section.partNumber}]`;
      default:
        return 'BODY[]';
    }
  }

  private shouldMarkAsRead(dataItems: FetchDataItem[]): boolean {
    return dataItems.some(item => 
      item.type === 'BODY' && !item.peek
    );
  }

  // Additional command handlers for complete IMAP support
  authenticate = async (tag: string, mechanism: string, initialResponse?: string) => {
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

  searchTyped = async (tag: string, searchRequest: SearchRequest, isUidCommand: boolean = false) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    try {
      const result = await this.store.search(this.selectedMailbox, [], isUidCommand);
      const resultType = isUidCommand ? "UID SEARCH" : "SEARCH";
      this.write(`* ${resultType} ${result.join(" ")}\r\n`);
      this.write(`${tag} OK SEARCH completed\r\n`);
    } catch (error) {
      console.error("Search failed:", error);
      this.write(`${tag} NO SEARCH failed\r\n`);
    }
  };

  storeFlagsTyped = async (tag: string, storeRequest: StoreRequest, isUidCommand: boolean = false) => {
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
      const useUid = isUidCommand || sequenceSet.type === 'uid';
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
        if (!silent && !operation.includes('SILENT')) {
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

  copyMessageTyped = async (tag: string, copyRequest: CopyRequest, isUidCommand: boolean = false) => {
    // Reject all COPY operations - we don't want clients moving messages around
    this.write(`${tag} NO [CANNOT] COPY not permitted\r\n`);
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
      `${tag} OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN] LOGIN completed\r\n`
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

  fetchMessages = async (tag: string, args: string[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    if (args.length < 2) {
      return this.write(
        `${tag} BAD FETCH requires sequence set and data items\r\n`
      );
    }

    const [sequenceSet, ...dataItems] = args;
    const dataItemsStr = dataItems.join(" ").toUpperCase();

    try {
      const isUidFetch =
        tag.startsWith("UID") ||
        dataItemsStr.includes("UID") ||
        args.includes("UID");
      const [startStr, endStr] = sequenceSet.split(":");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : start;

      if (isNaN(start) || (endStr && isNaN(end))) {
        return this.write(`${tag} BAD Invalid sequence number\r\n`);
      }

      const requestedFields = new Set<keyof MailType>(["uid"]);
      let needsBody = false;

      // Parse requested data items
      if (dataItemsStr.includes("ENVELOPE")) {
        requestedFields.add("subject");
        requestedFields.add("from");
        requestedFields.add("to");
        requestedFields.add("cc");
        requestedFields.add("bcc");
        requestedFields.add("date");
        requestedFields.add("messageId");
      }
      if (dataItemsStr.includes("FLAGS")) {
        requestedFields.add("read");
        requestedFields.add("saved");
      }
      if (
        dataItemsStr.includes("BODYSTRUCTURE") ||
        dataItemsStr.includes("BODY.PEEK[")
      ) {
        requestedFields.add("attachments");
        requestedFields.add("text");
        requestedFields.add("html");
      }
      if (
        dataItemsStr.includes("BODY[TEXT]") ||
        dataItemsStr.includes("RFC822.TEXT") ||
        dataItemsStr.includes("BODY.PEEK[TEXT]")
      ) {
        requestedFields.add("text");
        needsBody = true;
      }
      if (
        dataItemsStr.includes("BODY[HEADER]") ||
        dataItemsStr.includes("RFC822.HEADER") ||
        dataItemsStr.includes("BODY.PEEK[HEADER]")
      ) {
        requestedFields.add("subject");
        requestedFields.add("from");
        requestedFields.add("to");
        requestedFields.add("cc");
        requestedFields.add("bcc");
        requestedFields.add("date");
        requestedFields.add("messageId");
      }
      if (dataItemsStr.includes("BODY[]") || dataItemsStr.includes("RFC822")) {
        requestedFields.add("text");
        requestedFields.add("html");
        requestedFields.add("subject");
        requestedFields.add("from");
        requestedFields.add("to");
        requestedFields.add("cc");
        requestedFields.add("bcc");
        requestedFields.add("date");
        requestedFields.add("messageId");
        needsBody = true;
      }

      const messages = await this.store.getMessages(
        this.selectedMailbox,
        start,
        end,
        Array.from(requestedFields)
      );

      const isDomainInbox = this.selectedMailbox === "INBOX";
      let i = start - 1;

      const iterator = messages.entries();
      let current = iterator.next();

      while (!current.done) {
        const [id, mail] = current.value;
        const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
        const seqNum = isUidFetch ? uid : ++i;

        const parts: string[] = [];

        if (dataItemsStr.includes("UID")) {
          parts.push(`UID ${uid}`);
        }

        if (dataItemsStr.includes("FLAGS")) {
          const flags = [];
          if (mail.read) flags.push("\\Seen");
          if (mail.saved) flags.push("\\Flagged");
          parts.push(`FLAGS (${flags.join(" ")})`);
        }

        if (dataItemsStr.includes("ENVELOPE")) {
          const dateString = new Date(mail.date!).toUTCString();
          const subject = (mail.subject || "").replace(/"/g, '\\"');
          const from = formatAddressList(mail.from?.value);
          const to = formatAddressList(mail.to?.value);
          const cc = formatAddressList(mail.cc?.value);
          const bcc = formatAddressList(mail.bcc?.value);
          const messageId = mail.messageId || "<unknown@local>";
          const envelope = `ENVELOPE ("${dateString}" "${subject}" NIL NIL NIL (${from}) (${to}) (${cc}) (${bcc}) NIL "${messageId}")`;
          parts.push(envelope);
        }

        if (dataItemsStr.includes("BODYSTRUCTURE")) {
          const bodyStructure = formatBodyStructure(mail);
          parts.push(`BODYSTRUCTURE ${bodyStructure}`);
        }

        const isPreview = dataItemsStr.includes("BODY.PEEK");

        // Handle all BODY requests with unified partial fetch support
        // This regex captures all possible BODY request formats with optional partial fetch
        const allBodyMatches = dataItemsStr.matchAll(
          /(BODY(?:\.PEEK)?\[([^\]]*)\]|RFC822(?:\.TEXT|\.HEADER)?|BODY(?:\.PEEK)?\[\])(?:<(\d+)\.(\d+)>)?/g
        );
        
        let bodyMatch = allBodyMatches.next();
        while (!bodyMatch.done) {
          const [fullMatch, bodyExpr, partSpec, startStr, lengthStr] = bodyMatch.value;
          const isPartialFetch = startStr !== undefined && lengthStr !== undefined;
          const start = isPartialFetch ? parseInt(startStr, 10) : 0;
          const length = isPartialFetch ? parseInt(lengthStr, 10) : 0;
          
          let content = "";
          let bodyKey = "";
          
          // Determine content and key based on the body expression
          if (fullMatch.includes("RFC822.TEXT")) {
            content = mail.text || "";
            bodyKey = "BODY[TEXT]";
          } else if (fullMatch.includes("RFC822.HEADER")) {
            content = formatHeaders(mail);
            bodyKey = "BODY[HEADER]";
          } else if (fullMatch.includes("RFC822")) {
            content = this.buildFullMessage(mail);
            bodyKey = "BODY[]";
          } else if (partSpec === "") {
            // BODY[] or BODY.PEEK[]
            content = this.buildFullMessage(mail);
            bodyKey = "BODY[]";
          } else if (partSpec === "TEXT") {
            content = mail.text || "";
            bodyKey = "BODY[TEXT]";
          } else if (partSpec === "HEADER") {
            content = formatHeaders(mail);
            bodyKey = "BODY[HEADER]";
          } else if (partSpec && /^\d+(?:\.\d+)*$/.test(partSpec)) {
            // Numeric part like "1", "1.2", etc.
            const partContent = this.getBodyPart(mail, partSpec);
            if (partContent !== null) {
              content = partContent;
              bodyKey = `BODY[${partSpec}]`;
            }
          }
          
          if (content && bodyKey) {
            let finalContent = content;
            let actualLength = Buffer.byteLength(content, "utf8");
            
            // Apply partial fetch if requested
            if (isPartialFetch) {
              const contentBuffer = Buffer.from(content, "utf8");
              const endPos = Math.min(start + length, contentBuffer.length);
              
              if (start < contentBuffer.length) {
                finalContent = contentBuffer.subarray(start, endPos).toString("utf8");
                actualLength = Buffer.byteLength(finalContent, "utf8");
              } else {
                // Start position is beyond content length
                finalContent = "";
                actualLength = 0;
              }
            }
            
            parts.push(`${bodyKey} {${actualLength}}\r\n${finalContent}`);
          }
          
          bodyMatch = allBodyMatches.next();
        }

        this.write(`* ${seqNum} FETCH (${parts.join(" ")})\r\n`);

        if (!isPreview) {
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

  private buildFullMessage = (mail: Partial<MailType>): string => {
    const headers = formatHeaders(mail);
    const hasText = mail.text && mail.text.trim().length > 0;
    const hasHtml = mail.html && mail.html.trim().length > 0;
    const hasAttachments = mail.attachments && mail.attachments.length > 0;

    if (!hasText && !hasHtml && !hasAttachments) {
      return `${headers}\r\n\r\n`;
    }

    if (hasText && !hasHtml && !hasAttachments) {
      return `${headers}\r\n\r\n${mail.text}`;
    }

    if (!hasText && hasHtml && !hasAttachments) {
      return `${headers}\r\n\r\n${mail.html}`;
    }

    // For multipart messages, we need to build the MIME structure
    const boundary = "boundary_" + Date.now();
    let body = "";

    if (hasText && hasHtml && !hasAttachments) {
      // multipart/alternative
      const updatedHeaders = headers.replace(
        /Content-Type: [^\r\n]+/,
        `Content-Type: multipart/alternative; boundary="${boundary}"`
      );

      body = `${updatedHeaders}\r\n\r\n`;
      body += `--${boundary}\r\n`;
      body += `Content-Type: text/plain; charset=utf-8\r\n`;
      body += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
      body += `${mail.text}\r\n`;
      body += `--${boundary}\r\n`;
      body += `Content-Type: text/html; charset=utf-8\r\n`;
      body += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
      body += `${mail.html}\r\n`;
      body += `--${boundary}--\r\n`;
    } else if (hasAttachments) {
      // multipart/mixed
      const updatedHeaders = headers.replace(
        /Content-Type: [^\r\n]+/,
        `Content-Type: multipart/mixed; boundary="${boundary}"`
      );

      body = `${updatedHeaders}\r\n\r\n`;

      // Add text/html parts
      if (hasText && hasHtml) {
        const altBoundary = "alt_" + Date.now();
        body += `--${boundary}\r\n`;
        body += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
        body += `--${altBoundary}\r\n`;
        body += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
        body += `${mail.text}\r\n`;
        body += `--${altBoundary}\r\n`;
        body += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
        body += `${mail.html}\r\n`;
        body += `--${altBoundary}--\r\n`;
      } else if (hasText) {
        body += `--${boundary}\r\n`;
        body += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
        body += `${mail.text}\r\n`;
      } else if (hasHtml) {
        body += `--${boundary}\r\n`;
        body += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
        body += `${mail.html}\r\n`;
      }

      // Add attachments
      mail.attachments?.forEach((att) => {
        body += `--${boundary}\r\n`;
        body += `Content-Type: ${att.contentType}\r\n`;
        body += `Content-Transfer-Encoding: base64\r\n`;
        body += `Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n`;
        body += `${att.content.data}\r\n`;
      });

      body += `--${boundary}--\r\n`;
    }

    return body;
  };

  private getBodyPart = (mail: Partial<MailType>, partNum: string): string | null => {
    const parts = partNum.split(".");
    const mainPart = parseInt(parts[0], 10);

    const hasText = mail.text && mail.text.trim().length > 0;
    const hasHtml = mail.html && mail.html.trim().length > 0;
    const hasAttachments = mail.attachments && mail.attachments.length > 0;

    // Simple case: single part message
    if (!hasAttachments && !hasText && !hasHtml) {
      return null;
    }

    if (!hasAttachments) {
      if (hasText && hasHtml) {
        // multipart/alternative
        if (mainPart === 1) return mail.text || null;
        if (mainPart === 2) return mail.html || null;
      } else if (hasText && mainPart === 1) {
        return mail.text || null;
      } else if (hasHtml && mainPart === 1) {
        return mail.html || null;
      }
      return null;
    }

    // multipart/mixed with attachments
    let partIndex = 1;

    // First part is the body content
    if (mainPart === partIndex) {
      if (hasText && hasHtml) {
        // This would be a multipart/alternative part
        const subPart = parts[1] ? parseInt(parts[1], 10) : 1;
        if (subPart === 1) return mail.text || null;
        if (subPart === 2) return mail.html || null;
      } else if (hasText) {
        return mail.text || null;
      } else if (hasHtml) {
        return mail.html || null;
      }
    }

    partIndex++;

    // Subsequent parts are attachments
    const attachmentIndex = mainPart - partIndex;
    if (mail.attachments && attachmentIndex >= 0 && attachmentIndex < mail.attachments.length) {
      return mail.attachments[attachmentIndex].content.data;
    }

    return null;
  };

  storeFlags = async (tag: string, args: string[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    if (args.length < 3) {
      return this.write(
        `${tag} BAD STORE requires sequence set, operation, and flags\r\n`
      );
    }

    const [seq, op, ...flagsArgs] = args;
    const flags = flagsArgs.join(" ");

    try {
      const idx = parseInt(seq) - 1;
      if (isNaN(idx) || idx < 0) {
        return this.write(`${tag} BAD Invalid sequence number\r\n`);
      }

      const flagStr = flags
        .replace(/[\(\)]/g, "")
        .split(" ")
        .filter((f) => f);
      const updated = await this.store.setFlags(
        this.selectedMailbox,
        idx,
        flagStr
      );

      if (!updated) {
        this.write(`${tag} NO STORE failed\r\n`);
      } else {
        this.write(`* ${seq} FETCH (FLAGS (${flagStr.join(" ")}))\r\n`);
        this.write(`${tag} OK STORE completed\r\n`);
      }
    } catch (error) {
      console.error("Error storing flags:", error);
      this.write(`${tag} NO STORE failed\r\n`);
    }
  };

  copyMessage = async (tag: string, args: string[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    return this.write(`${tag} NO [UNSUPPORTED] COPY not supported\r\n`);
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

  search = async (tag: string, criteria: string[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    try {
      const result = await this.store.search(this.selectedMailbox, criteria);
      this.write(`* SEARCH ${result.join(" ")}\r\n`);
      this.write(`${tag} OK SEARCH completed\r\n`);
    } catch (error) {
      console.error("Search failed:", error);
      this.write(`${tag} NO SEARCH failed\r\n`);
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
      return this.write(`${tag} NO Not authenticated or no mailbox selected\r\n`);
    }

    if (this.isIdling) {
      return this.write(`${tag} BAD Already in IDLE mode\r\n`);
    }

    this.isIdling = true;
    this.idleTag = tag;

    // Register with IDLE manager
    const username = this.store.getUsername();
    idleManager.addIdleSession(this.sessionId, this, tag, this.selectedMailbox, username);

    // Send continuation response
    this.write("+ idling\r\n");

    // Set up socket listener for DONE command
    this.socket.on('data', this.handleIdleData);
  };

  /**
   * Handle data received during IDLE mode
   */
  private handleIdleData = (data: Buffer) => {
    if (!this.isIdling) return;

    const command = data.toString().trim().toUpperCase();
    if (command === 'DONE') {
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
    this.socket.off('data', this.handleIdleData);

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
