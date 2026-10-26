import type { ImapSession } from "./session";
import { logger } from "../logger";

const authenticatedSessions = new Set<ImapSession>();
const connectedSessions = new Set<ImapSession>();

/**
 * Track a live connection, authenticated or not, so
 * {@link shutdownImapSessions} can reach it. Runs from
 * `ImapRequestHandler.setSocket`, which is also where a STARTTLS upgrade drops
 * the cleartext session it replaces.
 */
export const registerConnection = (session: ImapSession) => {
  connectedSessions.add(session);
};

/** Drop a connection from the shutdown sweep. Runs on every socket close. */
export const unregisterConnection = (session: ImapSession) => {
  connectedSessions.delete(session);
};

/**
 * Track a connection that has completed AUTHENTICATE or LOGIN so
 * {@link evictImapSessions} can reach it later. IMAP holds authentication for
 * the life of the socket, so nothing else in the process can find a live
 * authenticated connection from outside its own handler.
 */
export const registerAuthenticatedSession = (session: ImapSession) => {
  authenticatedSessions.add(session);
};

/** Drop a connection from the registry. Runs on every socket close. */
export const unregisterSession = (session: ImapSession) => {
  authenticatedSessions.delete(session);
};

/**
 * Tear down every live connection that authenticated as `username`.
 *
 * Keyed on the credential the connection presented, never on the effective
 * user: a read-only session authenticates as its own credential, whose
 * password is a separate row, so it survives a rotation on the account it
 * reads.
 *
 * @returns the number of connections torn down
 */
export const evictImapSessions = (username: string) => {
  let evicted = 0;
  for (const session of authenticatedSessions) {
    if (session.getAuthenticatedAs() !== username) continue;
    authenticatedSessions.delete(session);
    // One socket that refuses teardown must not strand the rest of the sweep.
    try {
      session.write("* BYE Credential changed, please re-authenticate\r\n");
      session.close();
      evicted++;
    } catch (error) {
      logger.error(
        "Failed to evict an IMAP session",
        { component: "imap", sessionId: session.getSessionId() },
        error
      );
    }
  }
  if (evicted) {
    logger.info("Evicted IMAP sessions on credential change", {
      component: "imap",
      authenticatedAs: username,
      evicted,
    });
  }
  return evicted;
};

/**
 * Tear down every live connection, telling each one why.
 *
 * `Server.close` only stops accepting: its callback waits for every open
 * connection to end, and an idle client ends only when SOCKET_TIMEOUT_MS
 * reclaims it — long past a container's stop grace period.
 *
 * @returns the number of connections torn down
 */
export const shutdownImapSessions = () => {
  let closed = 0;
  for (const session of connectedSessions) {
    connectedSessions.delete(session);
    // Already on its way out: an IDLE session `idleManager.shutdown` has just
    // said BYE to, or a LOGOUT that beat the signal.
    const { socket } = session;
    if (socket.destroyed || socket.writableEnded) continue;
    // One socket that refuses teardown must not strand the rest of the sweep.
    try {
      session.write("* BYE Server shutting down\r\n");
      session.close();
      closed++;
    } catch (error) {
      logger.error(
        "Failed to close an IMAP session on shutdown",
        { component: "imap", sessionId: session.getSessionId() },
        error
      );
    }
  }
  return closed;
};

export const getAuthenticatedSessionCount = () => authenticatedSessions.size;

export const getConnectedSessionCount = () => connectedSessions.size;

/**
 * Test-only: forget every tracked connection without touching its socket. The
 * handler suites attach fake sockets that never emit `close`, and a shutdown
 * sweep that reached them would tear down another file's fixtures.
 */
export const _resetConnectedSessions = (): void => connectedSessions.clear();
