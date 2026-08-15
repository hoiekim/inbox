import { createServer, Socket } from "net";
import { createServer as createTLSServer } from "tls";
import { ImapRequestHandler } from "./handler";
import { getCapabilities } from "./capabilities";
import { readFileSync } from "fs";
import { logger } from "server";
import { getTlsCredentials } from "../tls";
import { sendAlarm } from "../alarm";

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
    // Loud, not a warn line: TLS was explicitly configured and cannot be
    // served, so the deployment is about to run cleartext-only while believing
    // it is encrypted. `/health` reports the TLS ports as `not_configured` and
    // stays 200, so nothing else pages for this.
    logger.error("IMAP: SSL certificate files not readable — TLS server not started", {
      component: "imap",
      cert: credentials.cert,
      key: credentials.key,
    });
    sendAlarm(
      "TLS certificate not readable",
      `IMAP is configured for TLS but cannot read its certificate, and is serving cleartext only.\n**cert:** ${credentials.cert}\n**key:** ${credentials.key}`,
      "tls-cert-unreadable"
    ).catch(() => undefined);
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
