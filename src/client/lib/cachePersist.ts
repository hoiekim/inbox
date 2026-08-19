import { queryClient } from "./queryClient";
import { matchCacheCatalog } from "./cacheCatalog";
import {
  idbClearQueries,
  idbDeleteQuery,
  idbGetAllQueries,
  idbPutQuery,
} from "./idbStore";

// The user whose data we may currently read and persist. null while logged out:
// persistence pauses (it never writes another user's cache) until the next
// bootstrap re-establishes it via setCacheUser().
let currentUserId: string | null = null;

/** React Query stores our keys as plain URL strings; normalize defensively. */
const queryKeyToUrl = (queryKey: unknown): string =>
  Array.isArray(queryKey) ? queryKey.map(String).join("") : String(queryKey);

export const setCacheUser = (userId?: string): void => {
  currentUserId = userId ?? null;
};

export const hydrateQueryCache = async (userId?: string): Promise<void> => {
  if (!userId) return;
  const now = Date.now();
  const entries = await idbGetAllQueries();
  for (const entry of entries) {
    if (entry.userId !== userId) {
      void idbDeleteQuery(entry.key);
      continue;
    }
    const catalog = matchCacheCatalog(entry.key);
    if (!catalog || now - entry.lastFetchedAt > catalog.maxAgeMs) {
      void idbDeleteQuery(entry.key);
      continue;
    }
    // Stamp the seed with when it was actually fetched, not now — the stale-
    // data notice reads dataUpdatedAt, and the default (hydration time) would
    // report week-old mail as just-fetched.
    queryClient.setQueryData(entry.key, catalog.revive(entry.payload), {
      updatedAt: entry.lastFetchedAt,
    });
  }
};

/**
 * Subscribe to the query cache and mirror every successful in-catalog query into
 * IndexedDB for the current user — including the post-mutation updates that flow
 * through setQueryData (mark read / save / delete), so the cache never lags the
 * UI. Returns React Query's unsubscribe function. Call once, after hydration.
 */
export const startCachePersistence = (): (() => void) =>
  queryClient.getQueryCache().subscribe((event) => {
    if (!event || event.type !== "queryUpdated" || !currentUserId) return;
    const query = event.query;
    if (query.state.status !== "success" || query.state.data === undefined) {
      return;
    }
    const url = queryKeyToUrl(query.queryKey);
    if (!matchCacheCatalog(url)) return;
    void idbPutQuery({
      key: url,
      payload: query.state.data,
      userId: currentUserId,
      // The query's own fetch stamp, not `now`. This subscription also fires
      // for hydration seeds and for optimistic setQueryData writes, both of
      // which carry an older dataUpdatedAt — stamping `now` would re-date a
      // week-old seed on every login and re-arm its maxAge expiry forever.
      lastFetchedAt: query.state.dataUpdatedAt,
    });
  });

/** Drop all persisted query data (e.g. on logout) and pause persistence. */
export const clearCachedQueries = async (): Promise<void> => {
  // Pause persistence first so any subscription firing during teardown can't
  // re-write a row after the clear below.
  currentUserId = null;
  // Drop the in-memory mirror of cacheable queries too, not just IDB, so the
  // logged-out client holds no cataloged data in React Query's cache.
  queryClient.removeQueries({
    predicate: (query) =>
      !!matchCacheCatalog(queryKeyToUrl(query.queryKey)),
  });
  await idbClearQueries();
};
