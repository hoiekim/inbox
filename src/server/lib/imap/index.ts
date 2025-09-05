import { Socket } from "net";
import { ImapSession } from "./session";
import { parseCommand } from "./parsers";
import { ImapRequestHandler } from "./handler";

export const imapListener = (socket: Socket) => {
  const session = new ImapSession(socket);
  const handler = new ImapRequestHandler(session);
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
        try {
          // Parse the command using the typed parser
          const parseResult = parseCommand(line.trim());

          if (parseResult.success && parseResult.value) {
            const { tag, request } = parseResult.value;
            await handler.handleRequest(tag, request);
          } else {
            // If parsing failed, send error response only if socket is writable
            if (!socket.destroyed && socket.writable) {
              const parts = line.trim().split(" ");
              const tag = parts[0] || "BAD";
              const errorMsg = parseResult.error || "Invalid command syntax";
              session.write(`${tag} BAD ${errorMsg}\r\n`);
            }
          }
        } catch (error) {
          console.error("Error processing command:", error);
          // Only send error response if socket is still writable
          if (!socket.destroyed && socket.writable) {
            const parts = line.trim().split(" ");
            const tag = parts[0] || "BAD";
            session.write(`${tag} BAD Internal server error\r\n`);
          }
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
