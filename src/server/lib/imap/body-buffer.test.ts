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
 *  6. Retention is bounded in BYTES (`IMAP_BODY_BUFFER_MAX_BYTES`), with
 *     an entry count as a secondary guard for zero-byte `nil`/`omit`
 *     results. Eviction is least-recently-USED: a cache hit refreshes
 *     recency, so a hammered key outlives a burst of distinct inserts.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  getSharedBodyResult,
  bodyBufferKey,
  _bodyBufferCacheSize,
  _bodyBufferBytes,
  _resetBodyBufferCache,
  _bodyBufferTtlMs,
  _bodyBufferMaxBytes,
  _bodyBufferMaxEntries,
  _setBodyBufferLimits,
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

  it("bounds retention by BYTES — evicts until the incoming buffer fits", async () => {
    // The cap has to be denominated in bytes because bytes are what the
    // container limits: a handful of distinct multi-MB bodies inside one
    // TTL window is hundreds of MB while sitting far below any plausible
    // entry count. 1KB budget + 400B bodies → at most 2 resident.
    _setBodyBufferLimits({ maxBytes: 1024 });
    const body = (label: string) => "x".repeat(400) + label;
    for (const label of ["a", "b", "c", "d"]) {
      await getSharedBodyResult(label, () => ({ kind: "content", text: body(label) }));
      expect(_bodyBufferBytes()).toBeLessThanOrEqual(1024);
    }
    // 4 × 401B against a 1024B ceiling → only the newest 2 survive.
    expect(_bodyBufferCacheSize()).toBe(2);
    expect(_bodyBufferBytes()).toBe(802);
    // Oldest gone, newest kept.
    let rebuiltA = false;
    await getSharedBodyResult("a", () => {
      rebuiltA = true;
      return { kind: "content", text: "re-a" };
    });
    expect(rebuiltA).toBe(true);
    let rebuiltD = false;
    await getSharedBodyResult("d", () => {
      rebuiltD = true;
      return { kind: "content", text: "re-d" };
    });
    expect(rebuiltD).toBe(false);
  });

  it("refuses to cache a single body larger than the whole byte budget", async () => {
    // Evicting everything still wouldn't make room, so the entry is served
    // and dropped rather than parked over the ceiling.
    _setBodyBufferLimits({ maxBytes: 512 });
    const r = await getSharedBodyResult("huge", () => ({
      kind: "content",
      text: "y".repeat(4096),
    }));
    if (r.kind !== "buffer") throw new Error();
    expect(r.buffer.byteLength).toBe(4096);
    expect(_bodyBufferCacheSize()).toBe(0);
    expect(_bodyBufferBytes()).toBe(0);
    // ...and the next caller rebuilds rather than getting a stale/absent hit.
    let rebuilt = false;
    await getSharedBodyResult("huge", () => {
      rebuilt = true;
      return { kind: "content", text: "again" };
    });
    expect(rebuilt).toBe(true);
  });

  it("keeps the entry count as a secondary guard for zero-byte results", async () => {
    // `nil`/`omit` carry no payload bytes, so the byte budget alone would
    // never bound them.
    _setBodyBufferLimits({ maxEntries: 4 });
    for (let i = 0; i < 20; i++) {
      await getSharedBodyResult(`nil-${i}`, () => ({ kind: "nil" }));
    }
    expect(_bodyBufferCacheSize()).toBe(4);
    expect(_bodyBufferBytes()).toBe(0);
  });

  it("is real LRU — a hammered key survives a burst of distinct inserts", async () => {
    // The entry a retry needs is by definition the recently-USED one.
    // Insertion-order eviction would drop the hottest key here.
    _setBodyBufferLimits({ maxEntries: 8 });
    for (let i = 0; i < 8; i++) {
      await getSharedBodyResult(`k${i}`, () => ({ kind: "content", text: `v${i}` }));
    }
    // Hammer the OLDEST-inserted key.
    for (let i = 0; i < 20; i++) {
      const hit = await getSharedBodyResult("k0", () => ({
        kind: "content",
        text: "must-not-rebuild",
      }));
      if (hit.kind !== "buffer") throw new Error();
      expect(hit.buffer.toString("utf8")).toBe("v0");
    }
    // A burst of new keys — one eviction each. k0 is now newest, so it
    // survives until 8 more distinct keys have displaced it.
    for (let i = 0; i < 7; i++) {
      await getSharedBodyResult(`new${i}`, () => ({ kind: "content", text: `n${i}` }));
    }
    expect(_bodyBufferCacheSize()).toBe(8);
    let k0Rebuilt = false;
    const k0 = await getSharedBodyResult("k0", () => {
      k0Rebuilt = true;
      return { kind: "content", text: "rebuilt" };
    });
    if (k0.kind !== "buffer") throw new Error();
    expect(k0Rebuilt).toBe(false);
    expect(k0.buffer.toString("utf8")).toBe("v0");
    // k1 — never re-used after insertion — is the one that got evicted.
    let k1Rebuilt = false;
    await getSharedBodyResult("k1", () => {
      k1Rebuilt = true;
      return { kind: "content", text: "rebuilt" };
    });
    expect(k1Rebuilt).toBe(true);
  });

  it("returns bytes to the budget on eviction and on reset", async () => {
    // Byte accounting must be symmetric — a leak here silently shrinks the
    // effective cache to nothing over a long uptime.
    _setBodyBufferLimits({ maxEntries: 2 });
    await getSharedBodyResult("b1", () => ({ kind: "content", text: "z".repeat(100) }));
    expect(_bodyBufferBytes()).toBe(100);
    await getSharedBodyResult("b2", () => ({ kind: "content", text: "z".repeat(200) }));
    expect(_bodyBufferBytes()).toBe(300);
    // b3 evicts b1 (100B) — accounting drops with it.
    await getSharedBodyResult("b3", () => ({ kind: "content", text: "z".repeat(50) }));
    expect(_bodyBufferCacheSize()).toBe(2);
    expect(_bodyBufferBytes()).toBe(250);
    _resetBodyBufferCache();
    expect(_bodyBufferBytes()).toBe(0);
    expect(_bodyBufferCacheSize()).toBe(0);
    // Reset also restores the env-derived limits.
    expect(_bodyBufferMaxEntries()).toBe(32);
    expect(_bodyBufferMaxBytes()).toBe(64 * 1024 * 1024);
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
