
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
  const cpSubstringMatch = sql.match(/SUBSTRING\((text|html)\s+FROM\s+\$3::int\s+FOR\s+\$4::int\)/);
  if (cpSubstringMatch) {
    const column = cpSubstringMatch[1] as "text" | "html";
    const [mail_id, , offset, take] = values as [string, string, number, number];
    substringCalls.push({ column, offset, take });
    const stored = columnStore.get(`${mail_id}:${column}`) ?? "";
    const codePoints = [...stored];
    const start = Math.max(0, offset - 1);
    const chunk = codePoints.slice(start, start + take).join("");
    return { rows: [{ chunk }], rowCount: 1 };
  }
  // pgByteChunks' shape: SUBSTRING(convert_to(col, 'UTF8') FROM $3::int
  // FOR $4::int) — returns raw UTF-8 bytes (Buffer). Slice by BYTE
  // offset. `convert_to(col, 'UTF8')` on a UTF8 server encoding is a
  // no-op transcode, i.e. it returns the column's raw UTF-8 bytes
  // verbatim — different from `col::bytea` which sends the text through
  // `byteain`'s escape parser and errors on any `\<letter>` sequence
  // (3.5% of the prod corpus). This mock encodes the stored text as
  // UTF-8 and returns the byte range; splitting a multi-byte sequence
  // mid-way is intentional (the consumer base64-encodes, not decodes).
  const byteSubstringMatch = sql.match(
    /SUBSTRING\(convert_to\((text|html),\s*'UTF8'\)\s+FROM\s+\$3::int\s+FOR\s+\$4::int\)/
  );
  if (byteSubstringMatch) {
    const column = byteSubstringMatch[1] as "text" | "html";
    const [mail_id, , offset, take] = values as [string, string, number, number];
    substringCalls.push({ column, offset, take });
    const stored = columnStore.get(`${mail_id}:${column}`) ?? "";
    const bytes = Buffer.from(stored, "utf8");
    const start = Math.max(0, offset - 1);
    const chunk = bytes.subarray(start, start + take);
    return { rows: [{ chunk }], rowCount: 1 };
  }
  if (/SUBSTRING\((text|html)::bytea\s+FROM/.test(sql)) {
    throw new Error(
      `Regression: pgByteChunks reverted to col::bytea cast. Use convert_to(col, 'UTF8') — ` +
      `col::bytea invokes byteain and rejects \\<letter> byte sequences (3.5% of prod corpus).`
    );
  }
  // Fail loud if a SUBSTRING call arrives in a shape the mock doesn't
  // recognize — silently returning empty rows would surface as "body vs
  // empty string" downstream, which reads as a data bug instead of a mock
  // out-of-date bug. The ::int casts are load-bearing (see pgTextChunks /
  // pgByteChunks in imap.ts), so any drift needs a matching mock update.
  if (/SUBSTRING/i.test(sql)) {
    throw new Error(
      `Mock does not recognize SUBSTRING shape — likely a drift from the pgTextChunks / pgByteChunks SQL. ` +
      `Expected pgTextChunks /SUBSTRING\\((text|html) FROM \\$3::int FOR \\$4::int\\)/ or ` +
      `pgByteChunks /SUBSTRING\\(convert_to\\((text|html), 'UTF8'\\) FROM \\$3::int FOR \\$4::int\\)/, got: ${sql}`
    );
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
  streamPartialFromSegments,
  streamBodyFromSegments,
  streamPartBodyFromSegments,
  sumBodyBytes,
  sumPartBodyBytes,
  computeFullMessageSize,
  sumSegmentBytes,
} = await import("./session-utils");
const { resetPool } = await import("../postgres/client");
const { pgTextChunks, PG_TEXT_CHUNK_CHARS, PG_TEXT_CHUNK_BYTES } = await import(
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

// ---------------------------------------------------------------------------
// streamPartialFromSegments — RFC 3501 §6.4.5 BODY[]<start.length> path
// ---------------------------------------------------------------------------

describe("streamPartialFromSegments — byte-range slice", () => {
  const drainToBuffer = async (
    stream: AsyncIterable<Buffer>
  ): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks as unknown as Uint8Array[]);
  };

  const baseHeaders = {
    subject: "partial-range",
    messageId: "<partial-range@test>",
    date: "2026-08-01T00:00:00Z",
    from: { text: "a@example.com", value: [{ address: "a@example.com", name: "" }] },
    to: { text: "b@example.com", value: [{ address: "b@example.com", name: "" }] },
    envelopeTo: [{ address: "b@example.com", name: "" }],
  } as const;

  // The parity invariant: streamPartialFromSegments(segs, start, length) is
  // byte-identical to the substring of the full concatenation. Sweeps a
  // grid of offsets across a body large enough to exercise multiple
  // pg SUBSTRING pulls per segment, both crossing and staying inside
  // individual segments.
  it("emits exactly the [start, start+length) slice of the full segment concat", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // ~50 KB text + ~200 KB html — small enough for the full concat to
    // fit in a test buffer, big enough that the html segment alone
    // spans multiple PG_TEXT_CHUNK_CHARS pulls.
    const text = "plain-body ".repeat(4500);
    const html = "<p>rich body</p>".repeat(12000);
    columnStore.set("mail-partial:text", text);
    columnStore.set("mail-partial:html", html);

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-partial",
        user_id: "user-1",
      } as never,
      "docId-partial"
    );
    const full = await drainToBuffer(streamFromSegments(segments));
    const total = full.byteLength;

    // Grid of (start, length) pairs designed to hit: (a) start-of-message,
    // (b) mid-segment cuts, (c) segment-boundary crossings, (d) end-of-body,
    // (e) length exceeding remaining bytes.
    const cases: Array<[number, number]> = [
      [0, 100],
      [0, total],
      [1, 1000],
      [Math.floor(total / 3), Math.floor(total / 3)],
      [total - 10, 10],
      [total - 100, 100_000], // over-request → clamp
    ];
    for (const [start, length] of cases) {
      const slice = await drainToBuffer(
        streamPartialFromSegments(segments, start, length)
      );
      const expected = full.subarray(start, Math.min(total, start + length));
      expect(
        slice.equals(expected as unknown as Uint8Array),
        `mismatch at start=${start} length=${length}: got ${slice.byteLength}B, expected ${expected.byteLength}B`
      ).toBe(true);
    }
  });

  it("returns an empty stream when start is at or past total", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    columnStore.set("mail-empty-slice:text", "hello");

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 5,
        html_octets: 0,
        mail_id: "mail-empty-slice",
        user_id: "user-1",
      } as never,
      "docId-empty-slice"
    );
    const total = sumSegmentBytes(segments) - 2; // exclude WIRE_TRAILER; partial has no trailer
    const past = await drainToBuffer(
      streamPartialFromSegments(segments, total + 100, 500)
    );
    expect(past.byteLength).toBe(0);
    const zeroLen = await drainToBuffer(
      streamPartialFromSegments(segments, 0, 0)
    );
    expect(zeroLen.byteLength).toBe(0);
  });

  it("peak chunk stays O(chunk) on a large lazy body — never materializes the whole slice", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // 800 KB html body — a whole-message materialize would be ~1.1 MB.
    const html = "z".repeat(800_000);
    columnStore.set("mail-partial-big:html", html);

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 0,
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-partial-big",
        user_id: "user-1",
      } as never,
      "docId-partial-big"
    );
    // Request a 400 KB slice from the middle of the message.
    const totalMsg = sumSegmentBytes(segments) - 2;
    const start = Math.floor(totalMsg / 3);
    const length = Math.min(400_000, totalMsg - start);
    let maxChunk = 0;
    let emitted = 0;
    for await (const chunk of streamPartialFromSegments(segments, start, length)) {
      emitted += chunk.byteLength;
      if (chunk.byteLength > maxChunk) maxChunk = chunk.byteLength;
    }
    expect(emitted).toBe(length);
    // Peak transient chunk is ~64 KiB (base64 of SLICE_RAW_BYTES /
    // PG_TEXT_CHUNK_BYTES). The 400 KB slice never appears as a single
    // Buffer.
    expect(maxChunk).toBeLessThan(80 * 1024);
    // Each SUBSTRING pull is bounded by PG_TEXT_CHUNK_BYTES (the partial-
    // fetch fast path uses pgByteChunks, not pgTextChunks — offset-aware
    // byte-indexed reads instead of an O(offset) drain-from-position-1).
    for (const call of substringCalls) {
      expect(call.take).toBe(PG_TEXT_CHUNK_BYTES);
    }
  });

  it("stops pulling upstream once the slice is satisfied — early-return releases the pg cursor", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const html = "y".repeat(500_000);
    columnStore.set("mail-early-return:html", html);

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 0,
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-early-return",
        user_id: "user-1",
      } as never,
      "docId-early-return"
    );

    // Request only the first 2000 bytes — reader should stop within the
    // first couple of SUBSTRING pulls, not drain the whole column.
    for await (const _ of streamPartialFromSegments(segments, 0, 2000)) {
      // consume
    }
    // A drain of the full column would need ~500_000 / PG_TEXT_CHUNK_BYTES
    // = ~11 pulls. Early-return should keep it to a small constant.
    expect(substringCalls.length).toBeLessThan(5);
  });

  it(
    "partial-fetch of the TAIL of a large lazy body: SUBSTRING count is O(len), not O(offset) — iOS retry-loop repro",
    async () => {
      substringCalls.length = 0;
      columnStore.clear();
      const html = "q".repeat(3_000_000);
      columnStore.set("mail-partial-tail:html", html);

      const segments = buildMessageSegments(
        {
          ...baseHeaders,
          text_octets: 0,
          html_octets: Buffer.byteLength(html, "utf8"),
          mail_id: "mail-partial-tail",
          user_id: "user-1",
        } as never,
        "docId-partial-tail"
      );
      // Simulate iOS's tail-window: request a 400 KB slice starting 3.9 MB
      // into the base64 body (well past the message midpoint).
      const totalMsg = sumSegmentBytes(segments) - 2;
      const start = totalMsg - 400_000 - 50_000;
      const length = 400_000;
      let emitted = 0;
      for await (const chunk of streamPartialFromSegments(segments, start, length)) {
        emitted += chunk.byteLength;
      }
      expect(emitted).toBe(length);

      expect(substringCalls.length).toBeLessThan(20);

      // Every SUBSTRING call must start FAR into the column — never at
      // offset 1 (the drain-from-1 anti-pattern this PR fixes). The
      // earliest byte we should ever touch is roughly (start - headers) *
      // 3 / 4 raw bytes into the column; a lower bound of 1 MB suffices to
      // prove we did NOT drain from position 1 on a 3.9 MB seek target.
      for (const call of substringCalls) {
        expect(call.offset).toBeGreaterThan(1_000_000);
      }
    }
  );

  it("partial-fetch on an astral-heavy lazy body: bytes match the corresponding full-fetch slice", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // Mix ASCII + astral (🏈) — verifies pgByteChunks' byte-indexed reads
    // don't drop or dupe chars at UTF-8 sequence boundaries. Base64
    // encoding of raw bytes doesn't care about UTF-8 boundaries; we just
    // need byte-for-byte fidelity with the whole-column encoding.
    const html = ("Hello 🏈 World " + "x".repeat(500)).repeat(400);
    columnStore.set("mail-astral-partial:html", html);
    const octets = Buffer.byteLength(html, "utf8");

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 0,
        html_octets: octets,
        mail_id: "mail-astral-partial",
        user_id: "user-1",
      } as never,
      "docId-astral-partial"
    );

    // Full-fetch reference bytes.
    const fullChunks: Buffer[] = [];
    for await (const c of sessionUtils.streamFromSegments(segments)) fullChunks.push(c);
    const full = Buffer.concat(fullChunks as unknown as Uint8Array[]);

    // Try three window shapes: head, middle, tail.
    const totalMsg = sumSegmentBytes(segments) - 2;
    const cases = [
      { start: 0, length: 12_000 },
      { start: Math.floor(totalMsg / 2), length: 8_000 },
      { start: totalMsg - 5_000, length: 5_000 },
    ];
    for (const { start, length } of cases) {
      const chunks: Buffer[] = [];
      for await (const c of streamPartialFromSegments(segments, start, length)) chunks.push(c);
      const partial = Buffer.concat(chunks as unknown as Uint8Array[]);
      expect(partial.byteLength).toBe(length);
      expect(partial.equals(full.subarray(start, start + length))).toBe(true);
    }
  });

  it(
    "partial-fetch on a body containing `\\<letter>` byte sequences: convert_to path handles it (`::bytea` would throw)",
    async () => {
      substringCalls.length = 0;
      columnStore.clear();
      const backslashSample =
        "prefix \\a mid \\C \\. \\z \\  end " + "x".repeat(400);
      const html = backslashSample.repeat(80);
      columnStore.set("mail-backslash:html", html);

      const segments = buildMessageSegments(
        {
          ...baseHeaders,
          text_octets: 0,
          html_octets: Buffer.byteLength(html, "utf8"),
          mail_id: "mail-backslash",
          user_id: "user-1",
        } as never,
        "docId-backslash"
      );

      const fullChunks: Buffer[] = [];
      for await (const c of sessionUtils.streamFromSegments(segments)) fullChunks.push(c);
      const full = Buffer.concat(fullChunks as unknown as Uint8Array[]);

      const totalMsg = sumSegmentBytes(segments) - 2;
      const start = Math.floor(totalMsg / 2);
      const length = 8_000;
      const partialChunks: Buffer[] = [];
      for await (const c of streamPartialFromSegments(segments, start, length)) {
        partialChunks.push(c);
      }
      const partial = Buffer.concat(partialChunks as unknown as Uint8Array[]);
      expect(partial.byteLength).toBe(length);
      expect(partial.equals(full.subarray(start, start + length))).toBe(true);
    }
  );

  it("partial-fetch alignment shim: mis-aligned skip trims up to 3 base64 chars before emit", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const html = "abcdefghij".repeat(10_000); // 100_000 ASCII bytes
    columnStore.set("mail-align:html", html);

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: 0,
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-align",
        user_id: "user-1",
      } as never,
      "docId-align"
    );

    // Full-fetch reference.
    const fullChunks: Buffer[] = [];
    for await (const c of sessionUtils.streamFromSegments(segments)) fullChunks.push(c);
    const full = Buffer.concat(fullChunks as unknown as Uint8Array[]);

    // Try every alignment offset (0..3 mod 4) at a well-into-the-body
    // start position — pgByteChunks seeks to the 3-byte-aligned raw
    // position and sliceStream shaves the residual.
    const totalMsg = sumSegmentBytes(segments) - 2;
    for (let offset = 0; offset < 4; offset++) {
      const start = Math.floor(totalMsg / 2) + offset;
      const length = 16_000;
      const chunks: Buffer[] = [];
      for await (const c of streamPartialFromSegments(segments, start, length)) chunks.push(c);
      const partial = Buffer.concat(chunks as unknown as Uint8Array[]);
      expect(partial.byteLength).toBe(length);
      expect(partial.equals(full.subarray(start, start + length))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// streamBodyFromSegments — BODY[TEXT] path (segments minus header literal)
// ---------------------------------------------------------------------------

describe("streamBodyFromSegments — TEXT payload = full concat minus header block", () => {
  const drainToBuffer = async (
    stream: AsyncIterable<Buffer>
  ): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks as unknown as Uint8Array[]);
  };

  const baseHeaders = {
    subject: "text-payload",
    messageId: "<text-payload@test>",
    date: "2026-08-01T00:00:00Z",
    from: { text: "a@example.com", value: [{ address: "a@example.com", name: "" }] },
    to: { text: "b@example.com", value: [{ address: "b@example.com", name: "" }] },
    envelopeTo: [{ address: "b@example.com", name: "" }],
  } as const;

  it("BODY[TEXT] bytes == full BODY[] bytes minus the initial header block", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const text = "plain-body ".repeat(3000);
    const html = "<p>rich body</p>".repeat(8000);
    columnStore.set("mail-textonly:text", text);
    columnStore.set("mail-textonly:html", html);

    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-textonly",
        user_id: "user-1",
      } as never,
      "docId-textonly"
    );
    const full = await drainToBuffer(streamFromSegments(segments));
    const body = await drainToBuffer(streamBodyFromSegments(segments));

    // The header literal is the first segment. Its byte length is what
    // separates FULL from TEXT.
    const headerSeg = segments[0];
    expect(headerSeg.kind).toBe("literal");
    const headerBytes =
      headerSeg.kind === "literal"
        ? Buffer.byteLength(headerSeg.value, "utf8")
        : 0;

    expect(body.byteLength).toBe(full.byteLength - headerBytes);
    // The TEXT payload should equal the FULL payload with its header block removed.
    expect(
      body.equals(full.subarray(headerBytes) as unknown as Uint8Array)
    ).toBe(true);
    // sumBodyBytes agrees with the drained count.
    expect(sumBodyBytes(segments)).toBe(body.byteLength);
  });
});

// ---------------------------------------------------------------------------
// streamPartBodyFromSegments — BODY[<partPath>] path (filter by partPath)
// ---------------------------------------------------------------------------

describe("streamPartBodyFromSegments — MIME_PART payload = body segment(s) at partPath", () => {
  const drainToBuffer = async (
    stream: AsyncIterable<Buffer>
  ): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks as unknown as Uint8Array[]);
  };

  const baseHeaders = {
    subject: "part-payload",
    messageId: "<part-payload@test>",
    date: "2026-08-01T00:00:00Z",
    from: { text: "a@example.com", value: [{ address: "a@example.com", name: "" }] },
    to: { text: "b@example.com", value: [{ address: "b@example.com", name: "" }] },
    envelopeTo: [{ address: "b@example.com", name: "" }],
  } as const;

  it("text-only mail: BODY[1] emits the base64-encoded text body", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const text = "Hello, world!";
    columnStore.set("mail-part-txt:text", text);
    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: 0,
        mail_id: "mail-part-txt",
        user_id: "user-1",
      } as never,
      "docId-part-txt"
    );
    const part1 = await drainToBuffer(streamPartBodyFromSegments(segments, "1"));
    // The base64 encoding of the text column, byte-for-byte.
    const expected = Buffer.from(text, "utf8").toString("base64");
    expect(part1.toString("utf8")).toBe(expected);
    expect(sumPartBodyBytes(segments, "1")).toBe(part1.byteLength);
  });

  it("multipart/alternative (text+html): BODY[1] = text, BODY[2] = html", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const text = "plain-body-alt";
    const html = "<p>rich-body-alt</p>";
    columnStore.set("mail-part-alt:text", text);
    columnStore.set("mail-part-alt:html", html);
    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-part-alt",
        user_id: "user-1",
      } as never,
      "docId-part-alt"
    );
    const part1 = await drainToBuffer(streamPartBodyFromSegments(segments, "1"));
    const part2 = await drainToBuffer(streamPartBodyFromSegments(segments, "2"));
    expect(part1.toString("utf8")).toBe(Buffer.from(text, "utf8").toString("base64"));
    expect(part2.toString("utf8")).toBe(Buffer.from(html, "utf8").toString("base64"));
    // Bogus partPath drains to empty.
    expect(sumPartBodyBytes(segments, "99")).toBe(0);
  });

  it("multipart/mixed with text+html+attachments: 1.1, 1.2, 2 all resolve", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const text = "plain-body-mixed";
    const html = "<p>rich-body-mixed</p>";
    columnStore.set("mail-part-mix:text", text);
    columnStore.set("mail-part-mix:html", html);
    // No attachment file on disk — `emitAttachment` will yield the
    // MISSING_ATTACHMENT_NOTICE base64 padded to advertised length,
    // which is fine for filter-parity purposes.
    const segments = buildMessageSegments(
      {
        ...baseHeaders,
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: "mail-part-mix",
        user_id: "user-1",
        attachments: [
          {
            content: { data: "no-such-att-id" },
            filename: "a.bin",
            contentType: "application/octet-stream",
            size: 100,
          },
        ] as never,
      } as never,
      "docId-part-mix"
    );
    const part11 = await drainToBuffer(
      streamPartBodyFromSegments(segments, "1.1")
    );
    const part12 = await drainToBuffer(
      streamPartBodyFromSegments(segments, "1.2")
    );
    const part2 = await drainToBuffer(streamPartBodyFromSegments(segments, "2"));
    expect(part11.toString("utf8")).toBe(Buffer.from(text, "utf8").toString("base64"));
    expect(part12.toString("utf8")).toBe(Buffer.from(html, "utf8").toString("base64"));
    // Part 2 = attachment content (missing → notice bytes)
    expect(part2.byteLength).toBeGreaterThan(0);
    // Sum functions agree with drained counts.
    expect(sumPartBodyBytes(segments, "1.1")).toBe(part11.byteLength);
    expect(sumPartBodyBytes(segments, "1.2")).toBe(part12.byteLength);
    expect(sumPartBodyBytes(segments, "2")).toBe(part2.byteLength);
    // Non-existent parts return 0 bytes.
    expect(sumPartBodyBytes(segments, "3")).toBe(0);
    expect(sumPartBodyBytes(segments, "1.3")).toBe(0);
  });
});
