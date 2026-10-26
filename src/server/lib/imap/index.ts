import { createServer, Server, Socket } from "net";
import { createServer as createTLSServer } from "tls";
import { ImapRequestHandler } from "./handler";
import { getCapabilities } from "./capabilities";
import { readFileSync } from "fs";
import { logger } from "server";
import { getTlsCredentials } from "../tls";
import { sendAlarm } from "../alarm";
import { boundCrashStep } from "../crash-alarm";
import { CLOSE_FLUSH_TIMEOUT_MS } from "./close-socket";
import { shutdownImapSessions } from "./session-registry";

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
      "tls-cert-unreadable-imap"
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

/**
 * How long shutdown waits for the IMAP listeners to close. Every session the
 * sweep reaches is destroyed by CLOSE_FLUSH_TIMEOUT_MS at the latest; the
 * margin lets those `close` events land. Anything still open after it belongs
 * to no session — an implicit-TLS handshake still in flight, which would
 * otherwise hold the listener for node's 120s `handshakeTimeout`.
 */
export const IMAP_SHUTDOWN_TIMEOUT_MS = CLOSE_FLUSH_TIMEOUT_MS + 1000;

/**
 * Stop the IMAP listeners and end every connection on them.
 *
 * Every live session is sent an untagged BYE (RFC 3501 §7.1.5) and torn down
 * through `closeSocket`, so the listeners' `close` callbacks fire once the
 * flush window has run instead of once each client idles out. The wait is
 * still bounded: the process exit that follows takes down whatever the sweep
 * could not reach.
 *
 * @returns whether every listener closed within the bound
 */
export const closeImapServers = async (servers: Server[]) => {
  let closed = false;
  const allClosed = Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  ).then(() => {
    closed = true;
  });
  const sessions = shutdownImapSessions();
  logger.info("IMAP sessions closed for shutdown", { component: "imap", sessions });
  await boundCrashStep(allClosed, IMAP_SHUTDOWN_TIMEOUT_MS);
  return closed;
};
