import { createServer, Socket } from "net";
import { createServer as createTLSServer } from "tls";
import { ImapRequestHandler } from "./handler";
import { getCapabilities } from "./capabilities";
import { readFileSync } from "fs";
import { logger } from "server";
import { getTlsCredentials } from "../tls";

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

  const credentials = getTlsCredentials();

  if (credentials.state === "unreadable") {
    logger.warn("IMAP: SSL certificate files not readable — TLS server not started", {
      component: "imap",
      cert: credentials.cert,
      key: credentials.key,
    });
  }

  if (credentials.state === "available") {
    const imapTlsServer = await new Promise<import("net").Server>((res) => {
      const port = getImapTlsPort();
      const imapListener = getImapListener(true);

      const tlsOptions = {
        key: readFileSync(credentials.key),
        cert: readFileSync(credentials.cert)
      };

      const server = createTLSServer(tlsOptions, imapListener);
      server.maxConnections = IMAP_MAX_CONNECTIONS;
      server.listen(port, () => {
        logger.info("IMAP server listening over TLS", { component: "imap", port });
        res(server);
      });
    });
    servers.push(imapTlsServer);
  } else if (credentials.state === "unconfigured") {
    logger.warn("IMAP: SSL certificate not configured, TLS server not started", { component: "imap" });
  }

  return servers;
};
