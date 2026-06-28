import { MailHeaderData } from "common";

/**
 * The single typed source of truth for which client queries are mirrored into
 * IndexedDB, plus each one's caching policy. Phase 1 reads this from the React
 * Query persistence layer (cachePersist.ts) to decide what to persist and how
 * to rebuild it on hydrate. Phase 2 (#458) will read the same table from the
 * service worker to decide what to serve offline — keep this the only place
 * that knows which endpoints are cacheable so the two layers can never drift.
 */
export interface CacheCatalogEntry {
  /** Stable identifier — for debugging and the Phase 2 service worker. */
  id: string;
  /**
   * Does a React Query key (always the request URL string in this app) belong
   * to this entry?
   */
  matches: (queryKey: string) => boolean;
  /**
   * Maximum age of a persisted entry that may still seed the cache before first
   * render. Entries older than this are dropped on hydrate (and never shown) so
   * a user returning after a long absence isn't greeted with very stale state.
   */
  maxAgeMs: number;
  /**
   * Rebuild the typed in-memory payload from the plain object read back out of
   * IndexedDB. Structured clone strips class prototypes, so a value stored as
   * `MailHeaderData[]` returns as plain objects; revive reconstructs the
   * instances exactly as the network path does (`new MailHeaderData(plain)`),
   * which keeps hydrated and freshly-fetched data identical for consumers.
   */
  revive: (payload: unknown) => unknown;
}

const WEEK_MS = 1000 * 60 * 60 * 24 * 7;

export const cacheCatalog: CacheCatalogEntry[] = [
  {
    id: "mail-headers",
    // headers list endpoints: /api/mails/headers/:account(?sent|new|saved).
    // Search results (/api/mails/search/...) are deliberately excluded — they
    // are query-specific and volatile, not worth seeding across sessions.
    matches: (key) => key.startsWith("/api/mails/headers/"),
    maxAgeMs: WEEK_MS,
    revive: (payload) =>
      Array.isArray(payload)
        ? payload.map((d) => new MailHeaderData(d as Partial<MailHeaderData>))
        : payload,
  },
];

/** The catalog entry that owns `queryKey`, or undefined if it isn't cacheable. */
export const matchCacheCatalog = (
  queryKey: string
): CacheCatalogEntry | undefined =>
  cacheCatalog.find((entry) => entry.matches(queryKey));
