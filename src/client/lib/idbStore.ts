import { openDB, type IDBPDatabase } from "idb";

/**
 * Typed wrapper over a single IndexedDB object store that mirrors cacheable
 * React Query responses (see cacheCatalog.ts). Every entry is scoped to the
 * user that fetched it so a browser shared by two accounts never seeds one
 * user's view with another's mail. All operations fail soft: when IndexedDB is
 * unavailable (private mode, an old browser, a non-DOM context) they no-op and
 * the app falls back to its normal network-only behavior.
 */
export interface CachedQuery {
  /** React Query key = the request URL. Primary key of the store. */
  key: string;
  /** Structured-cloneable response payload (class instances become plain). */
  payload: unknown;
  /** id of the user who fetched it; entries for other users are ignored. */
  userId: string;
  /** epoch ms the payload was last written, for catalog maxAge checks. */
  lastFetchedAt: number;
}

const DB_NAME = "inbox-query-cache";
const STORE = "queries";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

const getDb = (): Promise<IDBPDatabase> | null => {
  if (typeof indexedDB === "undefined") return null;
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      },
    }).catch((error) => {
      console.error("IndexedDB open failed; query cache disabled", error);
      // Reset so a later call can retry rather than reject forever.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
};

export const idbGetAllQueries = async (): Promise<CachedQuery[]> => {
  const dbp = getDb();
  if (!dbp) return [];
  try {
    return await (await dbp).getAll(STORE);
  } catch {
    return [];
  }
};

export const idbPutQuery = async (entry: CachedQuery): Promise<void> => {
  const dbp = getDb();
  if (!dbp) return;
  try {
    await (await dbp).put(STORE, entry);
  } catch (error) {
    console.error("IndexedDB write failed", error);
  }
};

export const idbDeleteQuery = async (key: string): Promise<void> => {
  const dbp = getDb();
  if (!dbp) return;
  try {
    await (await dbp).delete(STORE, key);
  } catch {
    /* fail soft — a failed eviction just leaves a stale entry */
  }
};

export const idbClearQueries = async (): Promise<void> => {
  const dbp = getDb();
  if (!dbp) return;
  try {
    await (await dbp).clear(STORE);
  } catch {
    /* fail soft */
  }
};
