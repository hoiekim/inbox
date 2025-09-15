import { Socket } from "net";
import { ImapSession } from "./session";
import { parseCommand } from "./parsers";
import { ImapRequestHandler } from "./handler";

export const imapListener = (socket: Socket) => {
  const session = new ImapSession(socket);
  const handler = new ImapRequestHandler(session);
  let buffer = "";

  socket.write(
    "* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN] IMAP4rev1 Service Ready\r\n"
  );

  socket.on("data", async (data) => {
    try {
      buffer += data.toString();

      // Process complete lines
      let lineEnd;
      while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.substring(0, lineEnd);
        buffer = buffer.substring(lineEnd + 2);

        if (line.trim()) {
          console.log(
            `[RAW] Received: "${line.trim()}"\n\tfor mailbox: ${
              session.selectedMailbox
            }`
          );

          // Check throttling before processing
          if (session.isThrottled()) {
            session.write(
              "* NO [TEMPORARY UNAVAILABLE] Server is busy. Please try again later.\r\n"
            );
            continue;
          }

          try {
            // Parse the command using the typed parser
            const parseResult = parseCommand(line.trim());

            if (parseResult.success && parseResult.value) {
              const { tag, request } = parseResult.value;
              await handler.handleRequest(tag, request);
            } else {
              // If parsing failed, send error response only if socket is writable
              console.log(
                `[PARSER] Parse failed for "${line.trim()}": ${
                  parseResult.error
                }`
              );
              const parts = line.trim().split(" ");
              const tag = parts[0] || "BAD";
              const errorMsg = parseResult.error || "Invalid command syntax";
              session.write(`${tag} BAD ${errorMsg}\r\n`);
            }
          } catch (error) {
            console.error("Error processing command:", error);
            // Only send error response if socket is still writable
            const parts = line.trim().split(" ");
            const tag = parts[0] || "BAD";
            session.write(`${tag} BAD Internal server error\r\n`);
          }
        }
      }
    } catch (error) {
      console.error("Error processing data:", error);
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  });

  socket.on("close", () => {
    console.log("IMAP connection closed");
  });

  socket.on("error", (error) => {
    if (!error.message.includes("ECONNRESET")) {
      console.error("IMAP socket error:", error);
    }
    if (!socket.destroyed) {
      socket.destroy();
    }
  });

  // Set socket timeout to prevent hanging connections
  socket.setTimeout(300000); // 5 minutes
  socket.on("timeout", () => {
    console.log("IMAP socket timeout");
    session.write("* BYE Timeout\r\n");
    if (!socket.destroyed) {
      socket.destroy();
    }
  });
};
