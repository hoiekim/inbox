import { Store } from "express-session";
import { elasticsearchClient, index } from "server";
import {
  Cookie,
  RuntimeCookie,
  RuntimeSession,
  RuntimeSessionType,
  Session
} from "common";

/**
 * Searches session data by id from Elasticsearch.
 * @param session_id
 * @returns  A promise to be a StoredSessionData object.
 */
export const searchSession = async (session_id: string) => {
  const data = await elasticsearchClient
    .get({ index, id: session_id })
    .catch((error) => {
      if (error.body?.found === false) return;
      throw new Error(
        `Failed to get session from Elasticsearch: ${session_id}`
      );
    });
  return data?._source?.session;
};

/**
 * Updates a session object with given session_id and session data.
 * @param session_id
 * @param session
 * @returns A promise to be an Elasticsearch response object.
 */
export const updateSession = async (session_id: string, session: Session) => {
  return elasticsearchClient.index({
    index,
    id: session_id,
    document: { type: "session", session, updated: new Date().toISOString() }
  });
};

/**
 * Deletes a session object with given session_id.
 * @param session_id
 * @returns A promise to be an Elasticsearch response object.
 */
export const deleteSession = async (session_id: string) => {
  return elasticsearchClient.delete({ index, id: session_id });
};

/**
 * Searches all expired session data and delete them.
 * @returns A promise to be an Elasticsearch response object.
 */
export const purgeSessions = async () => {
  const now = new Date().toISOString();
  return elasticsearchClient.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { type: "session" } },
          { range: { "session.cookie._expires": { lte: now } } }
        ]
      }
    }
  });
};

/**
 * Can be passed to 'store' option of express-session middleware to achieve persistent
 * session memory.
 */
export class ElasticsearchSessionStore extends Store {
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
    callback: (err: any, session?: RuntimeSessionType | null) => void
  ) => {
    try {
      const session = await searchSession(session_id);

      if (!session) {
        callback(null, null);
        return;
      }

      const { cookie: storedCookie } = session;
      const { _expires, secure, sameSite } = storedCookie;
      if (!_expires || new Date(_expires) < new Date()) {
        this.destroy(session_id);
        return callback(null, null);
      }

      const cookie = new RuntimeCookie({
        ...storedCookie,
        _expires: _expires && new Date(_expires),
        secure: secure && JSON.parse(secure),
        sameSite: sameSite && JSON.parse(sameSite)
      });

      const runtimeSession = new RuntimeSession({ ...session, cookie });

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
    callback?: (err?: any) => void
  ) => {
    if (!callback) return;

    try {
      const { cookie } = session;
      const {
        secure,
        sameSite,
        originalMaxAge,
        maxAge,
        signed,
        httpOnly,
        path,
        domain,
        _expires
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
        _expires
      });

      const storedSession = new Session({ ...session, cookie: storedCookie });

      await updateSession(session_id, storedSession);

      callback(null);
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Removes session data from Elasticsearch by given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  destroy = async (session_id: string, callback?: (err?: any) => void) => {
    if (!callback) return;
    try {
      await deleteSession(session_id);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  };
}
