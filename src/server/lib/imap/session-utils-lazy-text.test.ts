/**
 * Tests for the `lazy-text` MessageSegment variant — the pg-SUBSTRING body
 * stream that replaces "load the whole text/html column per FETCH" in
 * `buildMessageSegments`. Peak transient per BODY[] fetch drops from
 * O(body-length) (the pre-#738 shape re-introduced whenever the mail row
 * was loaded with text/html) to O(chunk), regardless of body size.
 *
 * Isolated to its own file so the pg-FakePool mock (Bun's `mock.module` is
 * process-global, per reference_bun_mock_module_global_hoisting.md) does
 * not bleed into the other IMAP test suites.
 */

import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// Record every SUBSTRING SELECT for peak-transient assertions. Also serves
// the FROM/FOR params so the test's expectations match what the reader
// would send at runtime.
const substringCalls: Array<{ column: "text" | "html"; offset: number; take: number }> = [];
// Map of `${mail_id}:${column}` → the full "column value" the mock backs it
// with. Each SUBSTRING call slices this string per its offset+take args.
const columnStore = new Map<string, string>();

const mockQuery = mock(async (sql: string, values: unknown[]) => {
  // Route SUBSTRING(text FROM ... FOR ...) / SUBSTRING(html FROM ... FOR ...)
  // through the columnStore. Every non-SUBSTRING query returns empty rows.
  const substringMatch = sql.match(/SUBSTRING\((text|html)\s+FROM\s+\$3\s+FOR\s+\$4\)/);
  if (substringMatch) {
    const column = substringMatch[1] as "text" | "html";
    const [mail_id, , offset, take] = values as [string, string, number, number];
    substringCalls.push({ column, offset, take });
    const stored = columnStore.get(`${mail_id}:${column}`) ?? "";
    // Pg SUBSTRING FROM is 1-indexed. Clamp for offsets past end.
    const start = Math.max(0, offset - 1);
    const chunk = stored.slice(start, start + take);
    return { rows: [{ chunk }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const {
  buildMessageSegments,
  streamFromSegments,
  computeFullMessageSize,
} = await import("./session-utils");
const { resetPool } = await import("../postgres/client");
const { pgTextChunks, PG_TEXT_CHUNK_CHARS } = await import(
  "../postgres/repositories/mails/imap"
);
const sessionUtils = await import("./session-utils");
type MessageSegment = ReturnType<typeof buildMessageSegments>[number];

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

// ---------------------------------------------------------------------------
// pgTextChunks — direct behaviour
// ---------------------------------------------------------------------------

describe("pgTextChunks — chunked SUBSTRING reader", () => {
  it("yields the full column reassembled byte-for-byte from ~12k-char chunks", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const body = "abcdefghijklmnopqrstuvwxyz".repeat(3000); // 78 000 chars
    columnStore.set("mail-1:html", body);

    const pieces: string[] = [];
    for await (const chunk of pgTextChunks("mail-1", "user-1", "html")) {
      pieces.push(chunk);
    }
    expect(pieces.join("")).toBe(body);
    // At least ceil(78000 / 12000) round-trips.
    expect(substringCalls.length).toBeGreaterThanOrEqual(
      Math.ceil(body.length / PG_TEXT_CHUNK_CHARS)
    );
    // No chunk pulled > PG_TEXT_CHUNK_CHARS.
    for (const call of substringCalls) {
      expect(call.take).toBe(PG_TEXT_CHUNK_CHARS);
    }
  });

  it("stops on empty column (0 SUBSTRING content) after exactly one probe", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    columnStore.set("mail-empty:text", "");
    const pieces: string[] = [];
    for await (const chunk of pgTextChunks("mail-empty", "user-1", "text")) {
      pieces.push(chunk);
    }
    expect(pieces).toEqual([]);
    expect(substringCalls.length).toBe(1);
  });

  it("stops after a short chunk (last read shorter than chunkChars)", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    columnStore.set("mail-short:text", "a".repeat(15_000));
    let count = 0;
    for await (const _chunk of pgTextChunks("mail-short", "user-1", "text")) count += 1;
    // 15000 chars: first pull returns 12000 (full), second returns 3000
    // (short) → stop. Two round-trips total.
    expect(count).toBe(2);
    expect(substringCalls.length).toBe(2);
    expect(substringCalls[0].offset).toBe(1);
    expect(substringCalls[1].offset).toBe(1 + PG_TEXT_CHUNK_CHARS);
  });

  it("chunkChars param overrides the default", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    columnStore.set("mail-custom:text", "a".repeat(1000));
    let count = 0;
    for await (const _chunk of pgTextChunks("mail-custom", "user-1", "text", 250)) {
      count += 1;
    }
    // 1000 / 250 = 4 full chunks, then an empty terminating probe. Since 4
    // full chunks of exactly 250 chars means the reader doesn't know it's
    // done from the length alone, it does one more SUBSTRING at offset 1001
    // which returns empty → stop.
    expect(count).toBe(4);
    expect(substringCalls.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// lazy-text segment: byte-length pre-measurement + streaming
// ---------------------------------------------------------------------------

describe("lazy-text MessageSegment — pre-measured `{N}` + chunked stream", () => {
  const drainToBuffer = async (
    stream: AsyncIterable<Buffer>
  ): Promise<{ concatenated: Buffer; maxChunkBytes: number }> => {
    const chunks: Buffer[] = [];
    let maxChunkBytes = 0;
    for await (const c of stream) {
      chunks.push(c);
      if (c.byteLength > maxChunkBytes) maxChunkBytes = c.byteLength;
    }
    return { concatenated: Buffer.concat(chunks), maxChunkBytes };
  };

  it("segmentByteLength for lazy-text matches base64ByteLen(octet_length)", () => {
    substringCalls.length = 0;
    columnStore.clear();
    const body = "hello world".repeat(500); // 5500 bytes ASCII
    columnStore.set("mail-2:text", body);

    // A lazy-text segment on its own — no headers, just the base64
    // encoding. `computeFullMessageSize` sums the segment list, which is
    // exactly what the {N} literal advertises.
    const segments: MessageSegment[] = [
      {
        kind: "lazy-text",
        source: "text",
        mail_id: "mail-2",
        user_id: "user-1",
        byteLength: Buffer.byteLength(body, "utf8"),
      },
    ];
    // Measurement is pure — never touches pool.query.
    const beforeMeasureCalls = substringCalls.length;
    const size = sessionUtils.sumSegmentBytes(segments);
    expect(substringCalls.length).toBe(beforeMeasureCalls);
    // WIRE_TRAILER (2 for the CRLF) is included by sumSegmentBytes.
    const expected = Math.ceil(Buffer.byteLength(body, "utf8") / 3) * 4 + 2;
    expect(size).toBe(expected);
  });

  it("stream drains the whole column and emitted bytes equal the pre-measured length", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // 100 KB ASCII — crosses many PG_TEXT_CHUNK_CHARS boundaries + several
    // emitBase64 slice boundaries.
    const body = "A".repeat(100 * 1024);
    columnStore.set("mail-3:html", body);

    const segments: MessageSegment[] = [
      {
        kind: "lazy-text",
        source: "html",
        mail_id: "mail-3",
        user_id: "user-1",
        byteLength: Buffer.byteLength(body, "utf8"),
      },
    ];
    const advertised =
      sessionUtils.sumSegmentBytes(segments) - 2; // strip WIRE_TRAILER
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    expect(concatenated.byteLength).toBe(advertised);
    // Round-trip check.
    const decoded = Buffer.from(concatenated.toString("utf8"), "base64").toString("utf8");
    expect(decoded).toBe(body);
  });

  it("stream produces byte-identical output to base64(mail.html) even split into ~12k chunks", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // Multibyte UTF-8 body — bytes != chars, and any splitting flaw would
    // corrupt the round-trip. 6-byte-per-char emoji is the worst case.
    const body = "café ☕ 日本語 😀 ".repeat(2000);
    columnStore.set("mail-4:text", body);

    const segments: MessageSegment[] = [
      {
        kind: "lazy-text",
        source: "text",
        mail_id: "mail-4",
        user_id: "user-1",
        byteLength: Buffer.byteLength(body, "utf8"),
      },
    ];
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    const wholeStreamOut = Buffer.from(body, "utf8").toString("base64");
    expect(concatenated.toString("utf8")).toBe(wholeStreamOut);
  });

  it("peak transient per stream is O(chunk) — no returned SUBSTRING > PG_TEXT_CHUNK_CHARS", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // 500 KB HTML body — the pre-fix shape held this whole string in memory
    // per in-flight FETCH. Post-fix, no single SUBSTRING result exceeds the
    // PG_TEXT_CHUNK_CHARS budget.
    const body = "<p>" + "x".repeat(500 * 1024 - 8) + "</p>";
    columnStore.set("mail-5:html", body);

    const segments: MessageSegment[] = [
      {
        kind: "lazy-text",
        source: "html",
        mail_id: "mail-5",
        user_id: "user-1",
        byteLength: Buffer.byteLength(body, "utf8"),
      },
    ];
    const { concatenated, maxChunkBytes } = await drainToBuffer(
      streamFromSegments(segments)
    );
    // Each SUBSTRING requested exactly PG_TEXT_CHUNK_CHARS characters.
    for (const call of substringCalls) {
      expect(call.take).toBe(PG_TEXT_CHUNK_CHARS);
    }
    // The number of round-trips scales with body size, not a fixed count.
    expect(substringCalls.length).toBeGreaterThanOrEqual(
      Math.floor(body.length / PG_TEXT_CHUNK_CHARS)
    );
    // Emitted base64 chunks stay under ~65 KiB (SLICE_RAW_BYTES base64
    // expansion). Load-bearing — proves the stream is genuinely chunked at
    // the wire level, not just at the SQL level.
    expect(maxChunkBytes).toBeLessThan(80 * 1024);
    // Full body round-trips.
    expect(concatenated.byteLength).toBeGreaterThan(0);
    const decoded = Buffer.from(concatenated.toString("utf8"), "base64").toString("utf8");
    expect(decoded).toBe(body);
  });

  it("computeFullMessageSize with a mixed segment list (literal + lazy-text + literal) is I/O-free", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    columnStore.set("mail-6:text", "irrelevant"); // pre-populate so real read would succeed

    const segments: MessageSegment[] = [
      { kind: "literal", value: "HEADERS\r\n\r\n" },
      {
        kind: "lazy-text",
        source: "text",
        mail_id: "mail-6",
        user_id: "user-1",
        byteLength: 12345,
      },
      { kind: "literal", value: "\r\n" },
    ];
    const size = sessionUtils.sumSegmentBytes(segments);
    // No SUBSTRING call — measurement uses the pre-measured `byteLength`.
    expect(substringCalls.length).toBe(0);
    // Sum: 11 + base64(12345) + 2 + 2 (WIRE_TRAILER)
    const expected = 11 + Math.ceil(12345 / 3) * 4 + 2 + 2;
    expect(size).toBe(expected);
  });
});

// Silence unused-import warnings — `computeFullMessageSize` is available in
// case a future assertion wants to compare against the wrapper's output.
void computeFullMessageSize;

// ---------------------------------------------------------------------------
// buildMessageSegments — lazy mode parity with materialized mode
// ---------------------------------------------------------------------------

describe("buildMessageSegments — lazy mode wire parity", () => {
  const drainToBuffer = async (
    stream: AsyncIterable<Buffer>
  ): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  };

  const baseHeaders = {
    subject: "hello",
    messageId: "<lazy@test>",
    date: "2026-07-30T00:00:00Z",
    from: { text: "a@example.com", value: [{ address: "a@example.com", name: "" }] },
    to: { text: "b@example.com", value: [{ address: "b@example.com", name: "" }] },
    envelopeTo: [{ address: "b@example.com", name: "" }],
  } as const;

  it("lazy segments AND materialized segments produce byte-identical BODY[] output", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const text = "plain body ".repeat(4000);
    const html = "<p>rich body</p>".repeat(4000);
    columnStore.set("mail-parity:text", text);
    columnStore.set("mail-parity:html", html);

    // Materialized path — strings on the mail.
    const materialized = buildMessageSegments(
      { ...baseHeaders, text, html } as never,
      "docId-parity"
    );
    // Lazy path — no strings, four synthetic fields.
    const lazy = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-parity",
        user_id: "user-1",
      } as never,
      "docId-parity"
    );

    const matBytes = await drainToBuffer(streamFromSegments(materialized));
    const lazyBytes = await drainToBuffer(streamFromSegments(lazy));
    expect(lazyBytes.equals(matBytes)).toBe(true);

    // And the pre-measured {N} literal matches on both sides.
    expect(sessionUtils.sumSegmentBytes(lazy)).toBe(
      sessionUtils.sumSegmentBytes(materialized)
    );
  });

  it("sumSegmentBytes on a lazy mail with a big body is I/O-free", () => {
    substringCalls.length = 0;
    columnStore.clear();
    // The store IS populated so a real read WOULD succeed — the point is
    // that sumSegmentBytes never issues one.
    columnStore.set("mail-io-free:text", "x".repeat(500_000));
    columnStore.set("mail-io-free:html", "y".repeat(500_000));

    const lazy = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 500_000,
        html_octets: 500_000,
        mail_id: "mail-io-free",
        user_id: "user-1",
      } as never,
      "docId-io-free"
    );
    const size = sessionUtils.sumSegmentBytes(lazy);
    expect(size).toBeGreaterThan(0);
    // No SUBSTRING calls fired during measurement — computeFullMessageSize
    // on a 1 MB body stays cheap enough to run per FETCH.
    expect(substringCalls.length).toBe(0);
  });

  it("lazy mail with text_octets=0 emits headers-only, matching a materialized empty mail", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    columnStore.set("mail-empty:text", "");
    columnStore.set("mail-empty:html", "");

    const lazy = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 0,
        html_octets: 0,
        mail_id: "mail-empty",
        user_id: "user-1",
      } as never,
      "docId-empty"
    );
    const materialized = buildMessageSegments(
      { ...baseHeaders, text: "", html: "" } as never,
      "docId-empty"
    );
    const lazyBytes = await drainToBuffer(streamFromSegments(lazy));
    const matBytes = await drainToBuffer(streamFromSegments(materialized));
    expect(lazyBytes.equals(matBytes)).toBe(true);
    // The whole thing was headers-only — no SUBSTRING pulls fired.
    expect(substringCalls.length).toBe(0);
  });

  it("peak transient stays chunked for a 500 KB lazy body", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const html = "<p>" + "x".repeat(500 * 1024 - 8) + "</p>";
    columnStore.set("mail-big:text", "");
    columnStore.set("mail-big:html", html);

    const lazy = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 0,
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-big",
        user_id: "user-1",
      } as never,
      "docId-big"
    );
    let maxBytes = 0;
    let emitted = 0;
    for await (const chunk of streamFromSegments(lazy)) {
      emitted += chunk.byteLength;
      if (chunk.byteLength > maxBytes) maxBytes = chunk.byteLength;
    }
    // {N} agrees with what actually got emitted.
    const advertised = sessionUtils.sumSegmentBytes(lazy) - 2;
    expect(emitted).toBe(advertised);
    // Peak transient chunk is ~64 KiB (base64 of SLICE_RAW_BYTES).
    expect(maxBytes).toBeLessThan(80 * 1024);
    // No SUBSTRING request > PG_TEXT_CHUNK_CHARS chars.
    for (const call of substringCalls) {
      expect(call.take).toBe(PG_TEXT_CHUNK_CHARS);
    }
    // Round-trip count scales with body size, not a fixed constant — the
    // 500 KB body forces multiple pulls, proving nothing materialized the
    // whole column at once.
    expect(substringCalls.length).toBeGreaterThanOrEqual(
      Math.floor(html.length / PG_TEXT_CHUNK_CHARS)
    );
  });
});
