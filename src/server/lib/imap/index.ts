import { createServer, Socket } from "net";
import { createServer as createTLSServer } from "tls";
import { ImapRequestHandler } from "./handler";
import { getCapabilities } from "./capabilities";
import { readFileSync, existsSync } from "fs";
import { logger } from "server";

export { idleManager } from "./idle-manager";

export const getImapListener = (isTls: boolean) => {
  return (socket: Socket) => {
    const handler = new ImapRequestHandler(isTls);
    handler.setSocket(socket);
    socket.write(
      `* OK [CAPABILITY ${getCapabilities(isTls)}] IMAP4rev1 Service Ready\r\n`
    );
  };
};

const IMAP_MAX_CONNECTIONS = 100;

export const getImapPort = () => Number(process.env.IMAP_PORT) || 143;
export const getImapTlsPort = () => Number(process.env.IMAP_TLS_PORT) || 993;

export const initializeImap = async () => {
  const servers: import("net").Server[] = [];

  const imapServer = await new Promise<import("net").Server>((res) => {
    const port = getImapPort();
    const imapListener = getImapListener(false);
    const server = createServer(imapListener);
    server.maxConnections = IMAP_MAX_CONNECTIONS;
    server.listen(port, () => {
      logger.info("IMAP server listening", { component: "imap", port });
      res(server);
    });
  });
  servers.push(imapServer);

  const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;
  const sslConfigured = SSL_CERTIFICATE && SSL_CERTIFICATE_KEY;
  const sslFilesExist = sslConfigured && existsSync(SSL_CERTIFICATE_KEY) && existsSync(SSL_CERTIFICATE);

  if (sslConfigured && !sslFilesExist) {
    logger.warn("IMAP: SSL certificate files not found — TLS server not started", {
      component: "imap",
      cert: SSL_CERTIFICATE,
      key: SSL_CERTIFICATE_KEY,
    });
  }

  if (sslFilesExist) {
    const imapTlsServer = await new Promise<import("net").Server>((res) => {
      const port = getImapTlsPort();
      const imapListener = getImapListener(true);

      const tlsOptions = {
        key: readFileSync(SSL_CERTIFICATE_KEY),
        cert: readFileSync(SSL_CERTIFICATE)
      };

      const server = createTLSServer(tlsOptions, imapListener);
      server.maxConnections = IMAP_MAX_CONNECTIONS;
      server.listen(port, () => {
        logger.info("IMAP server listening over TLS", { component: "imap", port });
        res(server);
      });
    });
    servers.push(imapTlsServer);
  } else if (!sslConfigured) {
    logger.warn("IMAP: SSL certificate not configured, TLS server not started", { component: "imap" });
  }

  return servers;
};
