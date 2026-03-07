import { Store } from "express-session";
import { pool } from "../client";
import {
  SessionModel,
  sessionsTable,
  SESSION_ID,
  SESSION_USER_ID,
  SESSION_USERNAME,
  SESSION_EMAIL,
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
 * @returns A promise to be a SessionModel or null.
 */
export const searchSession = async (
  session_id: string
): Promise<SessionModel | null> => {
  try {
    return await sessionsTable.queryOne({ [SESSION_ID]: session_id });
  } catch (error) {
    console.error(`Failed to get session from PostgreSQL: ${session_id}`, error);
    return null;
  }
};

/**
 * Updates a session object with given session_id and session data.
 * @param session_id
 * @param session
 * @returns A promise to be a success boolean.
 */
export const updateSession = async (
  session_id: string,
  session: Session
): Promise<boolean> => {
  try {
    const { user, cookie } = session;
    const data = {
      [SESSION_ID]: session_id,
      [SESSION_USER_ID]: user.id,
      [SESSION_USERNAME]: user.username,
      [SESSION_EMAIL]: user.email,
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

    const result = await sessionsTable.upsert(data);
    return result !== null;
  } catch (error) {
    console.error("Failed to update session:", error);
    return false;
  }
};

/**
 * Deletes a session object with given session_id.
 * @param session_id
 * @returns A promise to be a success boolean.
 */
export const deleteSession = async (session_id: string): Promise<boolean> => {
  try {
    return await sessionsTable.hardDelete(session_id);
  } catch (error) {
    console.error("Failed to delete session:", error);
    return false;
  }
};

/**
 * Searches all expired session data and delete them.
 * @returns A promise to be a count of deleted sessions.
 */
export const purgeSessions = async (): Promise<number> => {
  try {
    const now = new Date().toISOString();
    const sql = `
      DELETE FROM sessions 
      WHERE cookie_expires IS NOT NULL AND cookie_expires <= $1
      RETURNING session_id
    `;
    const result = await pool.query(sql, [now]);
    return result.rowCount ?? 0;
  } catch (error) {
    console.error("Failed to purge sessions:", error);
    return 0;
  }
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
    purgeSessions().catch(console.error);
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
    if (!callback) return;
    try {
      await deleteSession(session_id);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  };
}
