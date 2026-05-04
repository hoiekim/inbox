import type { QueryClient, QueryKey } from "react-query";

const DB_NAME = "inbox";
const STORE = "queries";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
};

const withStore = async <T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | undefined> => {
  try {
    const db = await openDB();
    return await new Promise<T>((resolve, reject) => {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      const req = op(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
};

export const idbGet = <T = unknown>(key: string): Promise<T | undefined> =>
  withStore<T>("readonly", (s) => s.get(key) as IDBRequest<T>);

export const idbSet = (key: string, value: unknown): Promise<unknown> =>
  withStore("readwrite", (s) => s.put(value, key));

export const idbDelete = (key: string): Promise<unknown> =>
  withStore("readwrite", (s) => s.delete(key));

export const idbClear = (): Promise<unknown> =>
  withStore("readwrite", (s) => s.clear());

const idbGetAll = async (): Promise<Map<string, unknown>> => {
  try {
    const db = await openDB();
    return await new Promise<Map<string, unknown>>((resolve, reject) => {
      const map = new Map<string, unknown>();
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          map.set(String(cursor.key), cursor.value);
          cursor.continue();
        } else {
          resolve(map);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return new Map();
  }
};

// Only persist queries whose keys match these patterns. Search results and
// transient/static fetches are intentionally excluded — they would either
// leak across users or never benefit from persistence.
const PERSIST_PATTERNS: RegExp[] = [
  /^\/api\/mails\/accounts$/,
  /^\/api\/mails\/headers\//
];

const keyToString = (key: QueryKey): string =>
  typeof key === "string" ? key : Array.isArray(key) ? String(key[0]) : String(key);

const shouldPersist = (key: string): boolean =>
  PERSIST_PATTERNS.some((p) => p.test(key));

/**
 * Populates the queryClient cache with last-known data from IndexedDB.
 * Call once during app boot before rendering, so the first paint shows
 * cached data immediately instead of a skeleton.
 */
export const hydrateQueryClient = async (queryClient: QueryClient): Promise<void> => {
  const all = await idbGetAll();
  for (const [key, value] of all) {
    if (!shouldPersist(key)) continue;
    queryClient.setQueryData(key, value);
  }
};

/**
 * Subscribes to queryClient cache mutations and mirrors persistable
 * queries into IndexedDB. Returns an unsubscribe function.
 *
 * Should be called AFTER hydrateQueryClient so the initial setQueryData
 * calls during hydration do not cause a write-back loop.
 */
export const attachIDBPersistence = (queryClient: QueryClient): (() => void) => {
  const cache = queryClient.getQueryCache();
  return cache.subscribe((event) => {
    if (!event) return;
    if (event.type !== "queryUpdated" && event.type !== "queryAdded") return;
    const query = event.query;
    if (!query) return;
    const key = keyToString(query.queryKey);
    if (!shouldPersist(key)) return;
    const data = query.state.data;
    if (data === undefined) {
      void idbDelete(key);
    } else {
      void idbSet(key, data);
    }
  });
};
