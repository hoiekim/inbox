import { singleFlight } from "../postgres/repositories/mails/inflight";

/**
 * Coalesce identical BODY-content serializations across concurrent FETCH
 * handlers.
 *
 * `getMailsByRange` (postgres/repositories/mails/imap.ts) already single-
 * flights the DB read — coalesced callers share one `PartialMailModel`
 * instance and, transitively, one `mail.html` / `mail.text` string. But
 * each handler was independently calling `buildFullMessage(mail)` and
 * base64-encoding the shared body, producing N distinct multi-MB JS
 * strings on top of the shared source. Under a client that pipelines
 * duplicate `UID FETCH X (BODY)` (observed: iOS Mail hammering a slow
 * response across a double-socket setup), those N strings pushed the
 * container's RSS past the OOM cap.
 *
 * This cache coalesces the SERIALIZATION step too. Concurrent identical
 * body-content builds share one `Buffer`; every coalesced caller
 * `writeChunked`s the same Buffer reference (`socket.write(buffer)` doesn't
 * copy — it enqueues a reference), so heap footprint stays at
 * O(distinct-in-flight-bodies) instead of O(callers).
 *
 * Why Buffer, not string:
 * - `Buffer.from(str, "utf8")` produces an allocation that lives outside
 *   V8's string heap, so the intermediate JS string built by
 *   `buildFullMessage` can be GC'd immediately after the encode.
 * - `socket.write(buffer)` skips the per-write UTF-8 conversion Node
 *   otherwise runs on string writes.
 *
 * Cache lifetime is the singleflight window: the entry deletes on
 * settle. That's the correct scope — the OOM comes from CONCURRENT
 * duplicate serializations; sequential callers can freely re-build.
 */
export const getSharedBodyBuffer = (
  cacheKey: string,
  build: () => string
): Promise<Buffer> =>
  singleFlight(`body:${cacheKey}`, async () => Buffer.from(build(), "utf8"));

/**
 * Cache-key shape: `<mailId>::<sectionKey>`. `mailId` scopes to a single
 * mail; `sectionKey` distinguishes BODY[] vs BODY[TEXT] vs BODY[HEADER]
 * etc. so two concurrent callers asking for DIFFERENT sections of the
 * same mail don't erroneously share a buffer.
 */
export const bodyBufferKey = (mailId: string, sectionKey: string): string =>
  `${mailId}::${sectionKey}`;
