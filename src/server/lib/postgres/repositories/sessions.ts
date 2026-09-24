import { Store } from "express-session";
import { logger } from "../../logger";
import {
  SessionModel,
  sessionsTable,
  SESSION_ID,
  SESSION_USER_ID,
  SESSION_USERNAME,
  SESSION_EMAIL,
  SESSION_IS_READ_ONLY,
  SESSION_AUTHENTICATED_AS,
  COOKIE_ORIGINAL_MAX_AGE,
  COOKIE_MAX_AGE,
  COOKIE_SIGNED,
  COOKIE_EXPIRES,
  COOKIE_HTTP_ONLY,
  COOKIE_PATH,
  COOKIE_DOMAIN,
  COOKIE_SECURE,
  COOKIE_SAME_SITE,
} from "../models";

// Import the common types (we'll need to adapt these)
import {
  Cookie,
  RuntimeCookie,
  RuntimeSession,
  RuntimeSessionType,
  Session,
} from "common";

/**
 * Searches session data by id from PostgreSQL.
 * @param session_id
 * @returns A promise to be a SessionModel, or null when no row carries that
 * id. A failed read rejects so callers can tell a store fault from a session
 * that does not exist.
 */
export const searchSession = async (
  session_id: string
): Promise<SessionModel | null> => {
  return sessionsTable.queryOne({ [SESSION_ID]: session_id });
};

/**
 * Updates a session object with given session_id and session data.
 * @param session_id
 * @param session
 * @returns A promise that settles once the row is written. A failed write
 * rejects so callers cannot report an unwritten session as a stored one.
 */
export const updateSession = async (
  session_id: string,
  session: Session
): Promise<void> => {
  const { user, cookie } = session;
  const data = {
    [SESSION_ID]: session_id,
    [SESSION_USER_ID]: user.id,
    [SESSION_USERNAME]: user.username,
    [SESSION_EMAIL]: user.email,
    [SESSION_IS_READ_ONLY]: user.isReadOnly ?? null,
    [SESSION_AUTHENTICATED_AS]: user.authenticatedAs ?? null,
    [COOKIE_ORIGINAL_MAX_AGE]: cookie.originalMaxAge,
    [COOKIE_MAX_AGE]: cookie.maxAge,
    [COOKIE_SIGNED]: cookie.signed,
    [COOKIE_EXPIRES]: cookie._expires,
    [COOKIE_HTTP_ONLY]: cookie.httpOnly,
    [COOKIE_PATH]: cookie.path,
    [COOKIE_DOMAIN]: cookie.domain,
    [COOKIE_SECURE]: cookie.secure,
    [COOKIE_SAME_SITE]: cookie.sameSite,
  };

  await sessionsTable.upsert(data);
};

/**
 * Deletes a session object with given session_id.
 * @param session_id
 * @returns A promise to be true when a row was deleted, false when no row
 * matched. A failed DELETE rejects so callers can tell failure from a
 * missing row.
 */
export const deleteSession = async (session_id: string): Promise<boolean> => {
  return sessionsTable.hardDelete(session_id);
};

/**
 * Searches all expired session data and delete them.
 * @returns A promise to be a count of deleted sessions. A failed sweep rejects,
 * so a table growing without bound is distinguishable from a sweep that found
 * nothing to purge.
 */
export const purgeSessions = async (): Promise<number> => {
  const now = new Date().toISOString();
  return sessionsTable.deleteWhere({
    [COOKIE_EXPIRES]: { op: "<=", value: now, notNull: true },
  });
};

/**
 * Deletes every session issued to a given authenticating credential.
 * Revoking a credential has to reach the sessions it already issued: the
 * cookie outlives the password it was minted from, and `rolling` renews its
 * window on every request, so a credential that is no longer accepted at login
 * would otherwise stay usable indefinitely through an existing session.
 * @param authenticatedAs
 * @returns A promise to be a count of deleted sessions. A failed delete
 * rejects, so a revocation that left its sessions alive cannot report itself
 * as a revocation that had none to delete.
 */
export const deleteSessionsAuthenticatedAs = async (
  authenticatedAs: string
): Promise<number> => {
  return sessionsTable.deleteWhere({
    [SESSION_AUTHENTICATED_AS]: authenticatedAs,
  });
};

/**
 * Can be passed to 'store' option of express-session middleware to achieve persistent
 * session memory.
 */
export class PostgresSessionStore extends Store {
  constructor() {
    super();
    this.autoRemoveScheduler();
  }

  /**
   * Repeatedly run every hour to remove expired session data.
   */
  private autoRemoveScheduler = () => {
    purgeSessions().catch((error) => logger.error("Failed to purge expired sessions", {}, error));
    setTimeout(this.autoRemoveScheduler, 1000 * 60 * 60);
  };

  /**
   * Gets session with given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  get = async (
    session_id: string,
    callback: (err: unknown, session?: RuntimeSessionType | null) => void
  ) => {
    try {
      const sessionModel = await searchSession(session_id);

      if (!sessionModel) {
        callback(null, null);
        return;
      }

      const { cookie_expires, cookie_secure, cookie_same_site } = sessionModel;
      if (!cookie_expires || new Date(cookie_expires) < new Date()) {
        this.destroy(session_id);
        return callback(null, null);
      }

      const cookie = new RuntimeCookie({
        originalMaxAge: sessionModel.cookie_original_max_age,
        maxAge: sessionModel.cookie_max_age ?? undefined,
        signed: sessionModel.cookie_signed ?? undefined,
        _expires: cookie_expires ? new Date(cookie_expires) : undefined,
        httpOnly: sessionModel.cookie_http_only ?? undefined,
        path: sessionModel.cookie_path ?? undefined,
        domain: sessionModel.cookie_domain ?? undefined,
        secure: cookie_secure ? JSON.parse(cookie_secure) : undefined,
        sameSite: cookie_same_site ? JSON.parse(cookie_same_site) : undefined,
      });

      const runtimeSession = new RuntimeSession();
      runtimeSession.user.id = sessionModel.session_user_id;
      runtimeSession.user.username = sessionModel.session_username;
      runtimeSession.user.email = sessionModel.session_email;
      if (sessionModel.session_is_read_only) {
        runtimeSession.user.isReadOnly = true;
        runtimeSession.user.authenticatedAs =
          sessionModel.session_authenticated_as ?? undefined;
      }
      runtimeSession.cookie = cookie;

      return callback(null, runtimeSession);
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Sets session with given session_id and session object.
   * @param session_id
   * @param session
   * @param callback
   */
  set = async (
    session_id: string,
    session: RuntimeSessionType,
    callback?: (err?: unknown) => void
  ) => {
    if (!callback) return;

    try {
      const { cookie, user } = session;
      const {
        secure,
        sameSite,
        originalMaxAge,
        maxAge,
        signed,
        httpOnly,
        path,
        domain,
        _expires,
      } = cookie;

      const storedCookie = new Cookie({
        secure: JSON.stringify(secure),
        sameSite: JSON.stringify(sameSite),
        originalMaxAge,
        maxAge,
        signed,
        httpOnly,
        path,
        domain,
        _expires,
      });

      const storedSession = new Session({ user, cookie: storedCookie });

      await updateSession(session_id, storedSession);

      callback(null);
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Removes session data from PostgreSQL by given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  destroy = async (session_id: string, callback?: (err?: unknown) => void) => {
    try {
      await deleteSession(session_id);
      callback?.(null);
    } catch (error) {
      if (!callback) {
        logger.error("Failed to delete session", { session_id }, error);
        return;
      }
      callback(error);
    }
  };
}
