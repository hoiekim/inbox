import type { ImapSession } from "./session";
import { logger } from "../logger";

const authenticatedSessions = new Set<ImapSession>();

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

export const getAuthenticatedSessionCount = () => authenticatedSessions.size;
