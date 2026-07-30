import { withBodyBudget } from "./body-budget";
import { singleFlight } from "../postgres/repositories/mails/inflight";

/**
 * Coalesce identical BODY-content serializations across FETCH handlers,
 * with a short-TTL post-settle cache so a sequential retry within the
 * window reuses the built Buffer instead of paying the multi-MB build
 * a second time.
 *
 * `getMailsByRange` (postgres/repositories/mails/imap.ts) already single-
 * flights the DB read — coalesced callers share one `PartialMailModel`
 * instance and, transitively, one `mail.html` / `mail.text` string. But
 * each handler was independently calling `buildFullMessage(mail)` and
 * base64-encoding the shared body, producing N distinct multi-MB JS
 * strings on top of the shared source. This cache coalesces the
 * SERIALIZATION step too — concurrent identical builds share one
 * `Buffer`; every coalesced caller `writeChunked`s the same Buffer
 * reference (`socket.write(buffer)` doesn't copy — it enqueues a
 * reference), so heap footprint stays at O(distinct-in-flight-bodies)
 * instead of O(callers).
 *
 * **Post-settle TTL (#729):** the earlier version deleted the cache
 * entry on `.finally` — correct for the concurrent-caller shape
 * (`getSharedBodyResult` originally addressed a duplicate-UID storm
 * where retries arrived WHILE the first build was in flight), but blind
 * to the shape iOS Mail actually generates: a fresh `UID FETCH X
 * (BODY[])` sent AFTER the previous response finished (aborted or
 * complete). IMAP command dispatch is strictly serialized per
 * connection (`handler.ts:239` awaits `handleRequest`), so the retry
 * arrives after the first build's promise has already settled and the
 * cache entry has been cleared. Keeping the resolved Buffer in a
 * bounded-TTL post-settle cache means the retry hits the cache and the
 * ~100MB peak allocation is not paid twice — avoiding the stacking
 * that OOM-killed the container on 2026-07-30 01:06:26 UTC.
 *
 * The tri-state result (buffer / nil / omit) preserves the three IMAP
 * response shapes `buildBodyResponsePart` had to distinguish BEFORE this
 * cache existed:
 * - **buffer**: normal literal response `{N}\r\n<octets>`.
 * - **nil**:   `<sectionKey> NIL` simple part (returned when the source
 *              body exists but is empty — e.g. BODY[TEXT] on a mail with
 *              no text/html/attachments).
 * - **omit**:  the whole FETCH-response part is dropped (returned when
 *              the section doesn't exist at all — e.g. BODY[99] on a
 *              2-part message).
 *
 * Encoding those inside the closure (not outside) is REQUIRED: if the
 * empty/omit check ran outside the singleflight, two concurrent callers
 * would each independently call `getBodyContent` — which for the big
 * cases means each redoes `buildFullMessage` (the multi-MB base64
 * encode). That's the exact per-caller allocation this cache is here to
 * eliminate.
 *
 * Why Buffer, not string, for the content case:
 * - `Buffer.from(str, "utf8")` allocates outside V8's string heap, so
 *   the intermediate JS string built by `buildFullMessage` can be GC'd
 *   immediately after the encode.
 * - `socket.write(buffer)` skips the per-write UTF-8 conversion Node
 *   otherwise runs on string writes.
 */

/** What the closure passed to `getSharedBodyResult` may return. */
export type BodyBuildResult =
  | { kind: "content"; text: string }
  | { kind: "nil" }
  | { kind: "omit" };

/** What coalesced callers receive from `getSharedBodyResult`. */
export type BodyCacheResult =
  | { kind: "buffer"; buffer: Buffer }
  | { kind: "nil" }
  | { kind: "omit" };

/**
 * How long a resolved Buffer stays cached after the build settles. Long
 * enough to catch iOS Mail's sequential retry (empirically within ~1s
 * of the aborted first response), short enough that memory-held Buffers
 * for one-off requests don't linger.
 *
 * Retune via `IMAP_BODY_BUFFER_TTL_MS`. Set to `0` to disable the
 * post-settle cache and fall back to singleflight-only behavior (the
 * pre-#729 shape).
 */
const DEFAULT_TTL_MS = 10_000;

const parseTtl = (): number => {
  const raw = process.env.IMAP_BODY_BUFFER_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_MS;
  return parsed;
};

const TTL_MS = parseTtl();

interface CacheEntry {
  result: BodyCacheResult;
  timer: NodeJS.Timeout;
}

const cache = new Map<string, CacheEntry>();

const setCached = (key: string, result: BodyCacheResult): void => {
  if (TTL_MS <= 0) return;
  const existing = cache.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => cache.delete(key), TTL_MS);
  // `unref` so a pending expiry timer doesn't block Node from exiting
  // (tests + graceful shutdown).
  timer.unref?.();
  cache.set(key, { result, timer });
};

// NOT `async` — two concurrent cache-miss callers with the same key must
// receive the SAME Promise reference so singleflight coalescing works at
// the identity level. An `async` wrapper would produce a fresh promise per
// call that awaits the coalesced one, still running work once but breaking
// the invariant that both callers hold the exact same promise object.
export const getSharedBodyResult = (
  cacheKey: string,
  build: () => BodyBuildResult
): Promise<BodyCacheResult> => {
  const key = `body:${cacheKey}`;

  // Post-settle cache: sequential retries within TTL reuse the resolved
  // Buffer directly — no rebuild, no singleflight, no budget slot.
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached.result);

  return singleFlight(key, async () =>
    // Budget-gate INSIDE the singleflight closure so N coalesced callers
    // consume ONE budget slot for one build, not N slots for N waiters.
    // A duplicate-UID storm (the shape #710/#713 addressed) would
    // otherwise starve legitimate distinct-UID callers by pinning every
    // slot on the same body build. See #726 / #727.
    withBodyBudget(async () => {
      const r = build();
      const result: BodyCacheResult =
        r.kind === "content"
          ? { kind: "buffer", buffer: Buffer.from(r.text, "utf8") }
          : r;
      setCached(key, result);
      return result;
    })
  );
};

/**
 * Cache-key shape: `<mailId>::<sectionKey>`. `mailId` scopes to a single
 * mail; `sectionKey` distinguishes BODY[] vs BODY[TEXT] vs BODY[HEADER]
 * etc. so two concurrent callers asking for DIFFERENT sections of the
 * same mail don't erroneously share a buffer.
 */
export const bodyBufferKey = (mailId: string, sectionKey: string): string =>
  `${mailId}::${sectionKey}`;

/** Exposed for tests: current TTL cache size + reset. */
export const _bodyBufferCacheSize = (): number => cache.size;
export const _resetBodyBufferCache = (): void => {
  for (const entry of cache.values()) clearTimeout(entry.timer);
  cache.clear();
};
export const _bodyBufferTtlMs = (): number => TTL_MS;
