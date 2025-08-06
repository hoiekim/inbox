import bcrypt from "bcrypt";
import { Socket } from "net";
import { Store } from "./store";
import { getUser } from "server";
import { formatAddressList, formatHeaders } from "./util";

export class ImapSession {
  private selectedMailbox: string | null = null;
  private store: Store | null = null;
  private authenticated: boolean = false;

  constructor(private socket: Socket) {}

  write = this.socket.write;

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

    const [seq, ...dataItems] = args;
    const dataItemsStr = dataItems.join(" ");

    try {
      const [startStr, endStr] = seq.split(":");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : start;

      if (isNaN(start) || (endStr && isNaN(end))) {
        return this.write(`${tag} BAD Invalid sequence number\r\n`);
      }

      const requestedFields: string[] = [
        "read",
        "date",
        "subject",
        "from",
        "to",
        "cc",
        "bcc"
      ];

      const sectionStr = dataItemsStr.toUpperCase();

      if (sectionStr.includes("ENVELOPE")) {
        // envelope needs those fields only
      } else if (
        sectionStr.includes("HEADER") ||
        sectionStr.includes("RFC822.HEADER")
      ) {
        requestedFields.push("subject", "from", "to", "cc", "bcc", "date");
      } else if (
        sectionStr.includes("TEXT") ||
        sectionStr.includes("RFC822.TEXT")
      ) {
        requestedFields.push("text");
      } else if (
        sectionStr.includes("BODY[]") ||
        sectionStr.includes("RFC822")
      ) {
        requestedFields.push("text", "html");
      }

      const messages = await this.store.getMessages(
        this.selectedMailbox,
        start,
        end,
        requestedFields
      );

      let i = start - 1;
      for (const mail of messages) {
        i++;
        const flags = [];
        if (mail.read) flags.push("\\Seen");
        if (mail.saved) flags.push("\\Flagged");

        if (sectionStr.includes("ENVELOPE")) {
          const e = {
            date: new Date(mail.date).toUTCString(),
            subject: mail.subject || "",
            from: formatAddressList(mail.from?.value),
            to: formatAddressList(mail.to?.value),
            cc: formatAddressList(mail.cc?.value),
            bcc: formatAddressList(mail.bcc?.value),
            inReplyTo: null,
            messageId: mail.messageId || "<unknown@local>"
          };

          this.write(
            `* ${i} FETCH (ENVELOPE ("${e.date}" "${e.subject}" NIL NIL NIL (${e.from}) (${e.to}) (${e.cc}) (${e.bcc}) NIL "${e.messageId}"))\r\n`
          );
          continue;
        }

        let content = "";
        if (
          sectionStr.includes("HEADER") ||
          sectionStr.includes("RFC822.HEADER")
        ) {
          content = formatHeaders(mail);
        } else if (
          sectionStr.includes("TEXT") ||
          sectionStr.includes("RFC822.TEXT")
        ) {
          content = mail.text || "";
        } else if (
          sectionStr.includes("BODY[]") ||
          sectionStr.includes("RFC822")
        ) {
          content = `${formatHeaders(mail)}\r\n\r\n${
            mail.text || mail.html || ""
          }`;
        }

        const length = Buffer.byteLength(content, "utf8");
        const flagsStr = flags.join(" ");

        if (sectionStr.includes("FLAGS")) {
          this.write(`* ${i} FETCH (FLAGS (${flagsStr}))\r\n`);
        } else {
          this.write(
            `* ${i} FETCH (FLAGS (${flagsStr}) BODY[] {${length}}\r\n${content})\r\n`
          );
        }
      }

      this.write(`${tag} OK FETCH completed\r\n`);
    } catch (error) {
      console.error("Error fetching messages:", error);
      this.write(`${tag} NO FETCH failed\r\n`);
    }
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

  logout = async (tag: string) => {
    this.store = null;
    this.selectedMailbox = null;
    this.authenticated = false;
    this.write("* BYE IMAP4rev1 Server logging out\r\n");
    this.write(`${tag} OK LOGOUT completed\r\n`);
    this.socket.end();
  };
}
