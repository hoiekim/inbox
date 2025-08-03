import { Socket } from "net";
import { ImapSession } from "./session";

enum Command {
  LOGIN,
  LIST,
  SELECT,
  FETCH,
  STORE,
  COPY,
  EXPUNGE,
  SEARCH,
  LOGOUT
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
    if (!isCommand(command)) {
      return session.write(`${tag} BAD Unknown command\r\n`);
    }
    switch (command) {
      case Command.LOGIN:
        return await session.login(tag, args);
      case Command.LIST:
        return await session.listMailboxes(tag);
      case Command.SELECT:
        return await session.selectMailbox(tag, args[0]);
      case Command.FETCH:
        return await session.fetchMessages(tag, args);
      case Command.STORE:
        return await session.storeFlags(tag, args);
      case Command.COPY:
        return await session.copyMessage(tag, args);
      case Command.EXPUNGE:
        return await session.expunge(tag);
      case Command.SEARCH:
        return await session.search(tag, args);
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

export const imapListener = (socket: Socket) => {
  const session = new ImapSession(socket);

  socket.write("* OK IMAP4rev1 Service Ready\r\n");

  socket.on("data", async (data) => {
    const lines = data.toString().split("\r\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.split(" ");
      const tag = parts[0];
      const command = parts[1]?.toUpperCase();
      const args = parts.slice(2);

      try {
        await handleCommand(tag, command, args, session);
      } catch (error) {
        console.error("Error processing command:", error);
        session.write(`${tag} BAD Internal server error\r\n`);
      }
    }
  });

  socket.on("close", () => {
    console.log("Connection closed");
  });
};
