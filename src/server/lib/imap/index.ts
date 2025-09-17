import { Socket } from "net";
import { ImapRequestHandler } from "./handler";
import { getCapabilities } from "./capabilities";

export const getImapListener = (port: number) => {
  return (socket: Socket) => {
    const handler = new ImapRequestHandler(port);
    handler.setSocket(socket);
    socket.write(
      `* OK [CAPABILITY ${getCapabilities(port)}] IMAP4rev1 Service Ready\r\n`
    );
  };
};
