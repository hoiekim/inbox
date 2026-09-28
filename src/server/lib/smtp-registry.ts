import type { SMTPServer } from "smtp-server";
import { logger } from "./logger";

/**
 * A live connection as held in `SMTPServer.connections`, whose element type the
 * package's typings leave as `any`. Declares only the members this module
 * touches; `send` then `close` is the library's own termination sequence.
 */
interface SmtpConnection {
  session?: { user?: string };
  send: (code: number, data: string) => void;
  close: () => void;
}

const liveServers = new Set<SMTPServer>();

/**
 * Track a listening server so {@link evictSmtpConnections} can reach its
 * connections. SMTP authenticates once per connection, so a client that
 * authenticated with a since-rotated password keeps its grant until the socket
 * closes.
 */
export const registerSmtpServer = (server: SMTPServer) => {
  liveServers.add(server);
};

/** Drop a server from the registry. Runs when the server closes. */
export const unregisterSmtpServer = (server: SMTPServer) => {
  liveServers.delete(server);
};

/**
 * Close every live connection authenticated as `username`, across every
 * listening port.
 *
 * `session.user` is the credential's own username (`onAuth` answers with the
 * name as presented), so a read-only connection is left alone when the account
 * it sends for rotates its password.
 *
 * @returns the number of connections closed
 */
export const evictSmtpConnections = (username: string) => {
  let evicted = 0;
  for (const server of liveServers) {
    const connections: Set<SmtpConnection> | undefined = server.connections;
    if (!connections) continue;
    for (const connection of connections) {
      if (connection.session?.user !== username) continue;
      // One connection that refuses teardown must not strand the sweep.
      try {
        connection.send(421, "Credential changed, please re-authenticate");
        connection.close();
        evicted++;
      } catch (error) {
        logger.error("Failed to evict an SMTP connection", {}, error);
      }
    }
  }
  if (evicted) {
    logger.info("Evicted SMTP connections on credential change", {
      authenticatedAs: username,
      evicted,
    });
  }
  return evicted;
};
