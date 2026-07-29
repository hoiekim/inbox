import { withBodyBudget } from "./body-budget";
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
 *
 * Cache lifetime is the singleflight window: the entry deletes on
 * settle. That's the correct scope — the OOM comes from CONCURRENT
 * duplicate serializations; sequential callers can freely re-build.
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

export const getSharedBodyResult = (
  cacheKey: string,
  build: () => BodyBuildResult
): Promise<BodyCacheResult> =>
  singleFlight(`body:${cacheKey}`, async () =>
    // Budget-gate INSIDE the singleflight closure so N coalesced callers
    // consume ONE budget slot for one build, not N slots for N waiters.
    // A duplicate-UID storm (the shape #710/#713 addressed) would
    // otherwise starve legitimate distinct-UID callers by pinning every
    // slot on the same body build. See #726 / #727.
    withBodyBudget(async () => {
      const r = build();
      if (r.kind !== "content") return r;
      return { kind: "buffer", buffer: Buffer.from(r.text, "utf8") };
    })
  );

/**
 * Cache-key shape: `<mailId>::<sectionKey>`. `mailId` scopes to a single
 * mail; `sectionKey` distinguishes BODY[] vs BODY[TEXT] vs BODY[HEADER]
 * etc. so two concurrent callers asking for DIFFERENT sections of the
 * same mail don't erroneously share a buffer.
 */
export const bodyBufferKey = (mailId: string, sectionKey: string): string =>
  `${mailId}::${sectionKey}`;
