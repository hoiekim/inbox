/**
 * getSharedBodyBuffer coalescing invariants:
 *  1. Concurrent identical (cacheKey, build) calls share ONE Buffer
 *     instance — only the first `build()` runs.
 *  2. Different cacheKeys build independently — no cross-key contamination.
 *  3. After the promise settles, the cache entry drops (singleflight
 *     lifetime); a later caller with the same key re-builds. Intentional:
 *     the OOM comes from CONCURRENT duplicate serializations, not
 *     sequential ones.
 *  4. Returns a Buffer — the whole point vs a string cache is that
 *     `socket.write(buffer)` skips the UTF-8 conversion and V8 can GC the
 *     intermediate JS string.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getSharedBodyBuffer, bodyBufferKey } from "./body-buffer";
import { inflightReset, inflightSize } from "../postgres/repositories/mails/inflight";

beforeEach(() => {
  inflightReset();
});

describe("getSharedBodyBuffer", () => {
  it("coalesces two concurrent callers on the same key to one build + one Buffer", async () => {
    let builds = 0;
    // Both calls fire in the same synchronous tick — the second sees the
    // pending entry that the first inserted before returning (singleflight
    // sync-set-before-return semantic).
    const p1 = getSharedBodyBuffer("k", () => {
      builds += 1;
      return "shared-body";
    });
    const p2 = getSharedBodyBuffer("k", () => {
      builds += 1;
      return "would-lose-if-ran";
    });
    // Both callers hold the SAME Promise reference — proof of coalescing at
    // the singleflight layer.
    expect(p1).toBe(p2);
    expect(inflightSize()).toBe(1);
    const [b1, b2] = await Promise.all([p1, p2]);
    expect(b1).toBe(b2);
    expect(b1.toString("utf8")).toBe("shared-body");
    // Only the first build ran. The second `build` callback was passed in
    // but singleflight dropped it — that's the whole point.
    expect(builds).toBe(1);
  });

  it("does NOT coalesce across different keys", async () => {
    const b1 = await getSharedBodyBuffer("k1", () => "one");
    const b2 = await getSharedBodyBuffer("k2", () => "two");
    expect(b1.toString("utf8")).toBe("one");
    expect(b2.toString("utf8")).toBe("two");
    expect(b1).not.toBe(b2);
  });

  it("returns a Buffer whose bytes match a UTF-8 encoding of build()'s output", async () => {
    // Multi-byte codepoints — proves the encoding is UTF-8 and byteLength
    // is the octet count, not the JS-string length.
    const src = "hello — wörld";
    const buf = await getSharedBodyBuffer("utf8", () => src);
    expect(buf.byteLength).toBe(Buffer.byteLength(src, "utf8"));
    expect(buf.toString("utf8")).toBe(src);
    // JS-string length would be 13 but UTF-8 byteLength is 16 (—: 3 bytes,
    // ö: 2 bytes). Guard the assertion from silently passing under
    // ASCII-only inputs.
    expect(buf.byteLength).not.toBe(src.length);
  });

  it("cache entry drops on settle so a later caller re-builds", async () => {
    let builds = 0;
    const run = () => getSharedBodyBuffer("k", () => {
      builds += 1;
      return `run-${builds}`;
    });
    const first = await run();
    expect(first.toString("utf8")).toBe("run-1");
    // singleflight semantics: entry cleared post-settle. Not a cache.
    expect(inflightSize()).toBe(0);
    const second = await run();
    expect(second.toString("utf8")).toBe("run-2");
    expect(builds).toBe(2);
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
