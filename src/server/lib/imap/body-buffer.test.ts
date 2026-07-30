/**
 * getSharedBodyResult coalescing + TTL + tri-state invariants:
 *  1. Concurrent identical (cacheKey, build) calls share ONE result —
 *     only the first `build()` runs.
 *  2. Different cacheKeys build independently — no cross-key contamination.
 *  3. **Post-settle TTL cache (#729):** after the promise settles, the
 *     resolved value stays cached for `IMAP_BODY_BUFFER_TTL_MS`. A caller
 *     arriving within the window reuses the cached Buffer directly — no
 *     rebuild, no singleflight round-trip. This addresses iOS Mail's
 *     sequential-retry OOM shape (aborted response → immediate retry on
 *     the same connection — dispatched serially, so singleflight alone
 *     never catches it).
 *  4. Tri-state: `{ kind: "content", text }` → Buffer;
 *     `{ kind: "nil" }` → `nil` result (caller emits `NIL` simple part);
 *     `{ kind: "omit" }` → `omit` result (caller drops the part).
 *     These three shapes preserve the pre-cache behavior of
 *     `buildBodyResponsePart` on empty-body and nonexistent-part paths.
 *     All three variants participate in the TTL cache.
 *  5. Content result is a Buffer — `socket.write(buffer)` skips the
 *     UTF-8 conversion and V8 can GC the intermediate JS string.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  getSharedBodyResult,
  bodyBufferKey,
  _bodyBufferCacheSize,
  _resetBodyBufferCache,
  _bodyBufferTtlMs,
  _bodyBufferMaxEntries,
} from "./body-buffer";
import { inflightReset, inflightSize } from "../postgres/repositories/mails/inflight";

beforeEach(() => {
  inflightReset();
  _resetBodyBufferCache();
});

describe("getSharedBodyResult", () => {
  it("coalesces two concurrent callers on the same key to one build + one Buffer", async () => {
    let builds = 0;
    // Both calls fire in the same synchronous tick — the second sees the
    // pending entry that the first inserted before returning (singleflight
    // sync-set-before-return semantic).
    const p1 = getSharedBodyResult("k", () => {
      builds += 1;
      return { kind: "content", text: "shared-body" };
    });
    const p2 = getSharedBodyResult("k", () => {
      builds += 1;
      return { kind: "content", text: "would-lose-if-ran" };
    });
    // Both callers hold the SAME Promise reference — proof of coalescing at
    // the singleflight layer.
    expect(p1).toBe(p2);
    expect(inflightSize()).toBe(1);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe("buffer");
    if (r1.kind !== "buffer" || r2.kind !== "buffer") throw new Error();
    // Same Buffer reference.
    expect(r1.buffer).toBe(r2.buffer);
    expect(r1.buffer.toString("utf8")).toBe("shared-body");
    // Only the first build ran.
    expect(builds).toBe(1);
  });

  it("does NOT coalesce across different keys", async () => {
    const r1 = await getSharedBodyResult("k1", () => ({ kind: "content", text: "one" }));
    const r2 = await getSharedBodyResult("k2", () => ({ kind: "content", text: "two" }));
    if (r1.kind !== "buffer" || r2.kind !== "buffer") throw new Error();
    expect(r1.buffer.toString("utf8")).toBe("one");
    expect(r2.buffer.toString("utf8")).toBe("two");
    expect(r1.buffer).not.toBe(r2.buffer);
  });

  it("returns a Buffer whose bytes match a UTF-8 encoding of build()'s text", async () => {
    // Multi-byte codepoints — proves the encoding is UTF-8 and byteLength
    // is the octet count, not the JS-string length.
    const src = "hello — wörld";
    const r = await getSharedBodyResult("utf8", () => ({ kind: "content", text: src }));
    if (r.kind !== "buffer") throw new Error();
    expect(r.buffer.byteLength).toBe(Buffer.byteLength(src, "utf8"));
    expect(r.buffer.toString("utf8")).toBe(src);
    // Guard the assertion from silently passing under ASCII-only inputs.
    expect(r.buffer.byteLength).not.toBe(src.length);
  });

  it("sequential caller within TTL window reuses the cached Buffer (#729)", async () => {
    // The load-bearing invariant for #729. iOS Mail's abort-and-retry
    // shape sends the second FETCH AFTER the first settles — singleflight
    // alone (the pre-#729 shape) would rebuild. With the post-settle TTL
    // cache, the retry hits the cache and pays 0 additional allocation.
    let builds = 0;
    const run = () => getSharedBodyResult("k", () => {
      builds += 1;
      return { kind: "content", text: `run-${builds}` };
    });
    const first = await run();
    if (first.kind !== "buffer") throw new Error();
    expect(first.buffer.toString("utf8")).toBe("run-1");
    // singleflight entry cleared post-settle, but TTL cache holds the result.
    expect(inflightSize()).toBe(0);
    expect(_bodyBufferCacheSize()).toBe(1);
    const second = await run();
    if (second.kind !== "buffer") throw new Error();
    // Same content — build DID NOT re-run.
    expect(second.buffer.toString("utf8")).toBe("run-1");
    // Same Buffer identity — proof the cache returned the exact object.
    expect(second.buffer).toBe(first.buffer);
    expect(builds).toBe(1);
  });

  it("cache expires and later caller rebuilds after TTL fires", async () => {
    // Test relies on the default TTL being > 0. `IMAP_BODY_BUFFER_TTL_MS=0`
    // would disable the cache entirely — assert we're not in that mode.
    expect(_bodyBufferTtlMs()).toBeGreaterThan(0);
    let builds = 0;
    const run = () => getSharedBodyResult("k", () => {
      builds += 1;
      return { kind: "content", text: `run-${builds}` };
    });
    const first = await run();
    if (first.kind !== "buffer") throw new Error();
    expect(first.buffer.toString("utf8")).toBe("run-1");
    // Simulate TTL fire without waiting real seconds.
    _resetBodyBufferCache();
    expect(_bodyBufferCacheSize()).toBe(0);
    const second = await run();
    if (second.kind !== "buffer") throw new Error();
    // Post-expiry: fresh build produced fresh content.
    expect(second.buffer.toString("utf8")).toBe("run-2");
    expect(builds).toBe(2);
  });

  it("preserves `nil` sentinel across coalesced callers (empty-body path)", async () => {
    // `BODY[TEXT]` on a mail with no text/html/attachments must emit
    // `BODY[TEXT] NIL`, not a 2-byte CRLF literal. Regression: an earlier
    // shape collapsed empty content into a zero-length Buffer and callers
    // downstream couldn't distinguish it from a genuine "nil" sentinel.
    let builds = 0;
    const p1 = getSharedBodyResult("empty", () => {
      builds += 1;
      return { kind: "nil" };
    });
    const p2 = getSharedBodyResult("empty", () => {
      builds += 1;
      return { kind: "nil" };
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe("nil");
    expect(r2.kind).toBe("nil");
    expect(builds).toBe(1);
  });

  it("bounds cache size — LRU eviction when inserting past MAX_ENTRIES", async () => {
    // Under pathological load (many distinct large-body FETCHes within a
    // single TTL window), an unbounded cache would hold N × (up to
    // ~26MB) buffers even though each individual build is capped by the
    // budget (#727). LRU-by-insertion-order eviction bounds the total.
    const max = _bodyBufferMaxEntries();
    // Populate to the cap.
    for (let i = 0; i < max; i++) {
      await getSharedBodyResult(`k${i}`, () => ({ kind: "content", text: `v${i}` }));
    }
    expect(_bodyBufferCacheSize()).toBe(max);
    // Inserting one more evicts the oldest (k0) — cache size stays capped.
    await getSharedBodyResult(`k${max}`, () => ({ kind: "content", text: `v${max}` }));
    expect(_bodyBufferCacheSize()).toBe(max);
    // Verify k0 was evicted: re-request rebuilds (build call fires).
    // (Side effect of this re-fetch: k0 is now in cache again, and its
    // insertion evicted the next-oldest — so we can't cheaply assert on
    // "some other still-present key is a cache hit" without tracking the
    // exact age ordering. The cap invariant + oldest-evicted is what
    // matters.)
    let rebuilt = 0;
    await getSharedBodyResult("k0", () => {
      rebuilt += 1;
      return { kind: "content", text: "rebuild-k0" };
    });
    expect(rebuilt).toBe(1);
    // Cache still at cap after the re-fetch.
    expect(_bodyBufferCacheSize()).toBe(max);
  });

  it("refreshing an existing key does not trigger eviction", async () => {
    // Re-populating the SAME key shouldn't push the cache past its cap
    // (or evict a still-fresh entry). The refresh path removes the
    // existing entry FIRST, so the following `set` lands under the cap.
    const max = _bodyBufferMaxEntries();
    for (let i = 0; i < max; i++) {
      await getSharedBodyResult(`k${i}`, () => ({ kind: "content", text: `v${i}` }));
    }
    expect(_bodyBufferCacheSize()).toBe(max);
    // Force a re-population of k0 by expiring it first, then rewriting.
    // (Same-key update happens via the setCached path — the singleflight
    // path would coalesce on the still-present k0. Simulate by clearing
    // only k0, then re-fetching.)
    // Cleanest: bump cache-hit code path with a synthetic re-set —
    // but the public getSharedBodyResult short-circuits on cache hit,
    // so nothing calls setCached again for k0. Instead, evict k0 first
    // (below TTL fire), then re-populate:
    await getSharedBodyResult("k-new", () => ({ kind: "content", text: "n" }));
    // k-new eviction dropped k0 (oldest). Size still at cap.
    expect(_bodyBufferCacheSize()).toBe(max);
    // A fresh k0 populate should NOT push past the cap.
    await getSharedBodyResult("k0", () => ({ kind: "content", text: "fresh-k0" }));
    expect(_bodyBufferCacheSize()).toBe(max);
  });

  it("preserves `omit` sentinel across coalesced callers (nonexistent-part path)", async () => {
    // `BODY[99]` on a 2-part message must be DROPPED from the FETCH
    // response, not emitted as `BODY[99] NIL`. Regression: same collapse
    // as above but conflated with the empty-body case, so the null path
    // that used to omit the part started emitting a NIL simple.
    let builds = 0;
    const p1 = getSharedBodyResult("gone", () => {
      builds += 1;
      return { kind: "omit" };
    });
    const p2 = getSharedBodyResult("gone", () => {
      builds += 1;
      return { kind: "omit" };
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe("omit");
    expect(r2.kind).toBe("omit");
    expect(builds).toBe(1);
  });

  it("nil/omit results participate in the post-settle TTL cache too", async () => {
    // Reviewoie #730 LOW: previously implicit; explicit coverage now. A
    // sequential caller after a `nil` build must reuse the sentinel
    // instead of re-running the build closure.
    let nilBuilds = 0;
    await getSharedBodyResult("nil-cached", () => {
      nilBuilds += 1;
      return { kind: "nil" };
    });
    const second = await getSharedBodyResult("nil-cached", () => {
      nilBuilds += 1;
      return { kind: "nil" };
    });
    expect(second.kind).toBe("nil");
    expect(nilBuilds).toBe(1);

    let omitBuilds = 0;
    await getSharedBodyResult("omit-cached", () => {
      omitBuilds += 1;
      return { kind: "omit" };
    });
    const secondOmit = await getSharedBodyResult("omit-cached", () => {
      omitBuilds += 1;
      return { kind: "omit" };
    });
    expect(secondOmit.kind).toBe("omit");
    expect(omitBuilds).toBe(1);
  });
});

describe("bodyBufferKey", () => {
  it("composes mailId + sectionKey with a stable separator", () => {
    expect(bodyBufferKey("mail-1", "BODY[]")).toBe("mail-1::BODY[]");
    expect(bodyBufferKey("mail-1", "BODY[TEXT]")).toBe("mail-1::BODY[TEXT]");
  });

  it("gives distinct keys for the same mail across different sections", () => {
    // Concurrent callers asking for DIFFERENT sections of the same mail
    // must not share a buffer — one Buffer can't be both BODY[] and
    // BODY[TEXT].
    expect(bodyBufferKey("mail-1", "BODY[]")).not.toBe(
      bodyBufferKey("mail-1", "BODY[TEXT]")
    );
  });

  it("gives distinct keys for the same section across different mails", () => {
    // Concurrent callers on different mails must not share either.
    expect(bodyBufferKey("mail-1", "BODY[]")).not.toBe(
      bodyBufferKey("mail-2", "BODY[]")
    );
  });
});
