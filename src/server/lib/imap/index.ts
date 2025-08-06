import { Socket } from "net";
import { ImapSession } from "./session";

enum Command {
  CAPABILITY = "CAPABILITY",
  NOOP = "NOOP",
  LOGIN = "LOGIN",
  AUTHENTICATE = "AUTHENTICATE",
  LIST = "LIST",
  LSUB = "LSUB",
  SELECT = "SELECT",
  EXAMINE = "EXAMINE",
  CREATE = "CREATE",
  DELETE = "DELETE",
  RENAME = "RENAME",
  SUBSCRIBE = "SUBSCRIBE",
  UNSUBSCRIBE = "UNSUBSCRIBE",
  STATUS = "STATUS",
  APPEND = "APPEND",
  CHECK = "CHECK",
  CLOSE = "CLOSE",
  EXPUNGE = "EXPUNGE",
  SEARCH = "SEARCH",
  FETCH = "FETCH",
  STORE = "STORE",
  COPY = "COPY",
  UID = "UID",
  LOGOUT = "LOGOUT"
}

const isCommand = (a: any): a is Command => {
  return Object.values(Command).includes(a);
};

const handleCommand = async (
  tag: string,
  command: string,
  args: string[],
  session: ImapSession
) => {
  try {
    const cmd = command.toUpperCase();

    if (!isCommand(cmd)) {
      return session.write(`${tag} BAD Unknown command\r\n`);
    }

    switch (cmd) {
      case Command.CAPABILITY:
        return session.write(
          `* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`
        );

      case Command.NOOP:
        return session.write(`${tag} OK NOOP completed\r\n`);

      case Command.LOGIN:
        return await session.login(tag, args);

      case Command.LIST:
        return await session.listMailboxes(tag);

      case Command.LSUB:
        // LSUB is similar to LIST but for subscribed mailboxes
        // For simplicity, we'll treat it the same as LIST
        return await session.listMailboxes(tag);

      case Command.SELECT:
        if (args.length < 1) {
          return session.write(`${tag} BAD SELECT requires mailbox name\r\n`);
        }
        return await session.selectMailbox(tag, args[0]);

      case Command.EXAMINE:
        // EXAMINE is like SELECT but read-only
        if (args.length < 1) {
          return session.write(`${tag} BAD EXAMINE requires mailbox name\r\n`);
        }
        return await session.selectMailbox(tag, args[0]);

      case Command.CREATE:
        // CREATE mailbox - not implemented for this email system
        return session.write(`${tag} NO CREATE not supported\r\n`);

      case Command.DELETE:
        // DELETE mailbox - not implemented for this email system
        return session.write(`${tag} NO DELETE not supported\r\n`);

      case Command.RENAME:
        // RENAME mailbox - not implemented for this email system
        return session.write(`${tag} NO RENAME not supported\r\n`);

      case Command.SUBSCRIBE:
        // SUBSCRIBE - not implemented, just return OK
        return session.write(`${tag} OK SUBSCRIBE completed\r\n`);

      case Command.UNSUBSCRIBE:
        // UNSUBSCRIBE - not implemented, just return OK
        return session.write(`${tag} OK UNSUBSCRIBE completed\r\n`);

      case Command.STATUS:
        // STATUS - basic implementation
        if (args.length < 2) {
          return session.write(
            `${tag} BAD STATUS requires mailbox name and status items\r\n`
          );
        }
        return session.write(`${tag} OK STATUS completed\r\n`);

      case Command.APPEND:
        // APPEND - not implemented for this read-only system
        return session.write(`${tag} NO APPEND not supported\r\n`);

      case Command.CHECK:
        // CHECK - just return OK
        return session.write(`${tag} OK CHECK completed\r\n`);

      case Command.CLOSE:
        return session.closeMailbox(tag);

      case Command.EXPUNGE:
        return await session.expunge(tag);

      case Command.SEARCH:
        return await session.search(tag, args);

      case Command.FETCH:
        return await session.fetchMessages(tag, args);

      case Command.STORE:
        return await session.storeFlags(tag, args);

      case Command.COPY:
        return await session.copyMessage(tag, args);

      case Command.UID:
        // UID commands - basic implementation
        if (args.length < 1) {
          return session.write(`${tag} BAD UID requires subcommand\r\n`);
        }

        const subCommand = args[0].toUpperCase();
        const subArgs = args.slice(1);

        switch (subCommand) {
          case "FETCH":
            return await session.fetchMessages(tag, subArgs);
          case "SEARCH":
            return await session.search(tag, subArgs);
          case "STORE":
            return await session.storeFlags(tag, subArgs);
          case "COPY":
            return await session.copyMessage(tag, subArgs);
          default:
            return session.write(`${tag} BAD Unknown UID subcommand\r\n`);
        }

      case Command.LOGOUT:
        return await session.logout(tag);

      default:
        return session.write(`${tag} BAD Unknown command\r\n`);
    }
  } catch (error) {
    console.error("Error handling command:", error);
    return session.write(`${tag} BAD Internal server error\r\n`);
  }
};

const parseCommand = (
  line: string
): { tag: string; command: string; args: string[] } => {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inLiteral = false;
  let literalLength = 0;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inLiteral) {
      current += char;
      literalLength--;
      if (literalLength === 0) {
        inLiteral = false;
      }
      continue;
    }

    if (char === '"' && !inQuotes) {
      inQuotes = true;
      continue;
    }

    if (char === '"' && inQuotes) {
      inQuotes = false;
      continue;
    }

    if (char === "{" && !inQuotes) {
      // Check for literal syntax {length}
      const closeBrace = line.indexOf("}", i);
      if (closeBrace !== -1) {
        const lengthStr = line.substring(i + 1, closeBrace);
        const length = parseInt(lengthStr, 10);
        if (!isNaN(length)) {
          literalLength = length;
          inLiteral = true;
          i = closeBrace;
          continue;
        }
      }
    }

    if (char === " " && !inQuotes) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  const tag = parts[0] || "";
  const command = parts[1] || "";
  const args = parts.slice(2);

  return { tag, command, args };
};

export const imapListener = (socket: Socket) => {
  const session = new ImapSession(socket);
  let buffer = "";

  socket.write(
    "* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN] IMAP4rev1 Service Ready\r\n"
  );

  socket.on("data", async (data) => {
    buffer += data.toString();

    // Process complete lines
    let lineEnd;
    while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.substring(0, lineEnd);
      buffer = buffer.substring(lineEnd + 2);

      if (line.trim()) {
        const { tag, command, args } = parseCommand(line.trim());

        try {
          await handleCommand(tag, command, args, session);
        } catch (error) {
          console.error("Error processing command:", error);
          session.write(`${tag} BAD Internal server error\r\n`);
        }
      }
    }
  });

  socket.on("close", () => {
    console.log("IMAP connection closed");
  });

  socket.on("error", (error) => {
    console.error("IMAP socket error:", error);
  });
};
