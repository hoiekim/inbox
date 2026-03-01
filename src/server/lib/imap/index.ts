import { createServer, Socket } from "net";
import { createServer as createTLSServer } from "tls";
import { ImapRequestHandler } from "./handler";
import { getCapabilities } from "./capabilities";
import { readFileSync } from "fs";
import { logger } from "../logger";

export const getImapListener = (port: number) => {
  return (socket: Socket) => {
    const handler = new ImapRequestHandler(port);
    handler.setSocket(socket);
    socket.write(
      `* OK [CAPABILITY ${getCapabilities(port)}] IMAP4rev1 Service Ready\r\n`
    );
  };
};

export const initializeImap = async () => {
  await new Promise<void>((res) => {
    const port = 143;
    const imapListener = getImapListener(port);
    const server = createServer(imapListener);
    server.listen(port, () => {
      logger.info("IMAP server listening", { component: "imap", port });
      res();
    });
  });

  await new Promise<void>((res) => {
    const port = 993;
    const imapListener = getImapListener(port);

    const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;

    if (!SSL_CERTIFICATE || !SSL_CERTIFICATE_KEY) {
      logger.warn("IMAP: SSL certificate not found, TLS server not started", { component: "imap" });
      res();
      return;
    }

    const tlsOptions = {
      key: readFileSync(SSL_CERTIFICATE_KEY),
      cert: readFileSync(SSL_CERTIFICATE)
    };

    const server = createTLSServer(tlsOptions, imapListener);
    server.listen(port, () => {
      logger.info("IMAP server listening over TLS", { component: "imap", port });
      res();
    });
  });

  return;
};
