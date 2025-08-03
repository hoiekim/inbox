import bcrypt from "bcrypt";
import { Socket } from "net";
import { Store } from "./store";
import { getUser } from "server";
import { formatAddressList, formatHeaders } from "./util";

export class ImapSession {
  private selectedMailbox: string | null = null;
  private store: Store | null = null;

  constructor(private socket: Socket) {}

  write = (data: string) => {
    this.socket.write(data);
  };

  login = async (tag: string, [username, password]: string[]) => {
    const inputUser = { username, password };
    const user = await getUser(inputUser);
    const signedUser = user?.getSigned();
    if (!inputUser.password || !user || !signedUser) {
      return this.write(`${tag} NO Invalid credentials.\r\n`);
    }

    const pwMatches = await bcrypt.compare(
      inputUser.password,
      user.password as string
    );

    if (!pwMatches) {
      return this.write(`${tag} NO Invalid credentials.\r\n`);
    }

    this.store = new Store(signedUser);

    return this.write(`${tag} OK LOGIN completed\r\n`);
  };

  listMailboxes = async (tag: string) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    const boxes = await this.store.listMailboxes();
    boxes.forEach((box) => {
      this.write(`* LIST (\\HasNoChildren) "/" "${box}"\r\n`);
    });
    this.write(`${tag} OK LIST completed\r\n`);
  };

  selectMailbox = async (tag: string, name: string) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    this.selectedMailbox = name;
    const count = this.store.countMessages(name);

    if (count === null) {
      this.write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    this.write(`* ${count} EXISTS\r\n`);
    this.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
  };

  fetchMessages = async (tag: string, [seq, section]: string[]) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    const [startStr, endStr] = seq.split(":");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : start;

    const sectionStr = section?.toUpperCase() || "BODY[]";
    const requestedFields: string[] = [
      "read",
      "date",
      "subject",
      "from",
      "to",
      "cc",
      "bcc"
    ];

    if (sectionStr === "ENVELOPE") {
      // envelope needs those fields only
    } else if (sectionStr.includes("HEADER")) {
      requestedFields.push("subject", "from", "to", "cc", "bcc", "date");
    } else if (sectionStr.includes("TEXT")) {
      requestedFields.push("text");
    } else {
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

      if (sectionStr === "ENVELOPE") {
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
      if (sectionStr.includes("HEADER")) {
        content = formatHeaders(mail);
      } else if (sectionStr.includes("TEXT")) {
        content = mail.text || "";
      } else {
        content = `${formatHeaders(mail)}\r\n\r\n${
          mail.text || mail.html || ""
        }`;
      }

      const length = Buffer.byteLength(content, "utf8");
      const flagsStr = flags.join(" ");
      this.write(
        `* ${i} FETCH (FLAGS (${flagsStr}) BODY[] {${length}}\r\n${content})\r\n`
      );
    }

    this.write(`${tag} OK FETCH completed\r\n`);
  };

  storeFlags = async (tag: string, [seq, op, flags]: string[]) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    const idx = parseInt(seq) - 1;
    const flagStr = flags.replace(/[\(\)]/g, "").split(" ");
    const updated = this.store.setFlags(this.selectedMailbox, idx, flagStr);
    if (!updated) {
      this.write(`${tag} NO STORE failed\r\n`);
    } else {
      this.write(`* ${seq} FETCH (FLAGS (${flagStr.join(" ")}))\r\n`);
      this.write(`${tag} OK STORE completed\r\n`);
    }
  };

  copyMessage = async (tag: string, [seq, dest]: string[]) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    const idx = parseInt(seq) - 1;
    try {
      await this.store.copyMessage(this.selectedMailbox, dest, idx);
      this.write(`${tag} OK COPY completed\r\n`);
    } catch (error) {
      console.error("Copying message failed:", error);
      this.write(`${tag} NO COPY failed\r\n`);
    }
  };

  expunge = async (tag: string) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    try {
      this.store.expunge(this.selectedMailbox);
      this.write(`${tag} OK EXPUNGE completed\r\n`);
    } catch (error) {
      console.error("Copying message failed:", error);
      this.write(`${tag} NO EXPUNGE failed\r\n`);
    }
  };

  search = async (tag: string, criteria: string[]) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }

    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }

    const result = await this.store.search(this.selectedMailbox, criteria);
    this.write(`* SEARCH ${result.join(" ")}\r\n`);
    this.write(`${tag} OK SEARCH completed\r\n`);
  };

  logout = async (tag: string) => {
    if (!this.store) {
      return this.write(`${tag} NO Not logged in.\r\n`);
    }
    this.store = null;
    this.selectedMailbox = null;
    this.write("* BYE IMAP4rev1 Server logging out\r\n");
    this.write(`${tag} OK LOGOUT completed\r\n`);
    this.socket.end();
  };
}
