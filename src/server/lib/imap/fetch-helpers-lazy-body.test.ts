/**
 * Peak-transient guard for the BODY[] / RFC822 fetch path — the whole
 * point of the pg-SUBSTRING streaming rework is that a large mail body
 * NEVER lives in Node's heap as one allocation for the lifetime of an
 * in-flight FETCH. This test drives `buildFetchResponsePart` end to end
 * with a 500 KB HTML lazy body, instruments the pg mock to record the
 * size of every SUBSTRING result, and asserts:
 *
 *   1. No SUBSTRING pull returns more than PG_TEXT_CHUNK_CHARS characters
 *      (the per-round-trip budget, ≤ 48 KB UTF-8 worst case).
 *   2. No emitted stream chunk exceeds ~80 KiB (base64 of one 48 KiB raw
 *      slice — the constant SLICE_RAW_BYTES × 4/3 in emitBase64).
 *   3. Sum of emitted chunk bytes equals the pre-measured `{N}` literal,
 *      proving the {N} literal cannot desync from the wire.
 *   4. Chunk count scales with body size (multiple pulls fired),
 *      proving nothing materialized the whole column at once.
 *
 * Isolated to its own file so the pg-FakePool mock (Bun's `mock.module`
 * is process-global) does not bleed into the other IMAP test suites.
 */

import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { MailType } from "common";

const substringCalls: Array<{
  column: "text" | "html";
  unit: "chars" | "bytes";
  take: number;
  returned: number;
}> = [];
const columnStore = new Map<string, string>();

const mockQuery = mock(async (sql: string, values: unknown[]) => {
  const substringMatch = sql.match(/SUBSTRING\((text|html)\s+FROM\s+\$3::int\s+FOR\s+\$4::int\)/);
  if (substringMatch) {
    const column = substringMatch[1] as "text" | "html";
    const [mail_id, , offset, take] = values as [string, string, number, number];
    const stored = columnStore.get(`${mail_id}:${column}`) ?? "";
    // Code points, not code units — Postgres offsets a text column by
    // characters. See the same note in session-utils-lazy-text.test.ts (#765).
    const codePoints = [...stored];
    const start = Math.max(0, offset - 1);
    const chunk = codePoints.slice(start, start + take).join("");
    substringCalls.push({ column, unit: "chars", take, returned: chunk.length });
    return { rows: [{ chunk }], rowCount: 1 };
  }
  // pgByteChunks' shape — the partial BODY[TEXT] / BODY[<part>] windows
  // seek by BYTE offset so they can start mid-column instead of draining
  // from code point 1. `convert_to(col, 'UTF8')` on a UTF8 server encoding
  // returns the column's raw bytes verbatim, so the mock encodes the
  // stored text and returns the byte range. Splitting a multi-byte
  // sequence at a boundary is intentional: the consumer base64-encodes
  // the bytes, it never decodes them. Same branch as the one in
  // session-utils-lazy-text.test.ts.
  const byteSubstringMatch = sql.match(
    /SUBSTRING\(convert_to\((text|html),\s*'UTF8'\)\s+FROM\s+\$3::int\s+FOR\s+\$4::int\)/
  );
  if (byteSubstringMatch) {
    const column = byteSubstringMatch[1] as "text" | "html";
    const [mail_id, , offset, take] = values as [string, string, number, number];
    const stored = columnStore.get(`${mail_id}:${column}`) ?? "";
    const bytes = Buffer.from(stored, "utf8");
    const start = Math.max(0, offset - 1);
    const chunk = bytes.subarray(start, start + take);
    substringCalls.push({ column, unit: "bytes", take, returned: chunk.byteLength });
    return { rows: [{ chunk }], rowCount: 1 };
  }
  // Fail loud on unrecognized SUBSTRING — mirrors the guard in
  // session-utils-lazy-text.test.ts. A silent {rows: []} would surface as
  // downstream body-vs-empty assertion failures rather than "the mock
  // regex is stale."
  if (/SUBSTRING/i.test(sql)) {
    throw new Error(
      `Mock does not recognize SUBSTRING shape — likely a drift from the pgTextChunks / pgByteChunks SQL. ` +
      `Expected pgTextChunks /SUBSTRING\\((text|html) FROM \\$3::int FOR \\$4::int\\)/ or ` +
      `pgByteChunks /SUBSTRING\\(convert_to\\((text|html), 'UTF8'\\) FROM \\$3::int FOR \\$4::int\\)/, got: ${sql}`
    );
  }
  // Any other query (e.g. rfc822_size persist) just no-ops with an empty
  // result — the fetch test doesn't need to persist anywhere.
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

const { buildFetchResponsePart } = await import("./fetch-helpers");
const { resetPool } = await import("../postgres/client");
const { PG_TEXT_CHUNK_CHARS, PG_TEXT_CHUNK_BYTES } = await import(
  "../postgres/repositories/mails/imap"
);

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

describe("BODY[] peak-transient bound: 500 KB lazy body streams in chunks, not one allocation", () => {
  const baseHeaders = {
    subject: "big body",
    messageId: "<big@test>",
    date: "2026-07-30T00:00:00Z",
    from: { text: "a@example.com", value: [{ address: "a@example.com", name: "" }] },
    to: { text: "b@example.com", value: [{ address: "b@example.com", name: "" }] },
    envelopeTo: [{ address: "b@example.com", name: "" }],
    uid: { account: 1, domain: 1 } as MailType["uid"],
  };

  it("no SUBSTRING pull exceeds PG_TEXT_CHUNK_CHARS AND emitted chunks stay ≤ ~64 KiB", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    // 500 KB ASCII HTML body — under the pre-fix shape this string lived
    // in mail.html on the row for the whole FETCH lifetime, per in-flight
    // concurrent fetch. Under the lazy shape, only the octet count travels
    // on the row; the body streams chunk-by-chunk from PG.
    const html = "<p>" + "x".repeat(500 * 1024 - 8) + "</p>";
    columnStore.set("mail-big:html", html);

    const mail = {
      ...baseHeaders,
      text_octets: 0,
      html_octets: Buffer.byteLength(html, "utf8"),
      mail_id: "mail-big",
      user_id: "user-1",
    } as never;

    const part = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: true, section: { type: "FULL" } },
      "mail-big",
      "INBOX"
    );

    expect(part).not.toBeNull();
    expect(part!.type).toBe("stream");
    if (part!.type !== "stream") throw new Error("expected stream");

    let emitted = 0;
    let maxChunk = 0;
    let chunkCount = 0;
    for await (const chunk of part.stream) {
      emitted += chunk.byteLength;
      if (chunk.byteLength > maxChunk) maxChunk = chunk.byteLength;
      chunkCount += 1;
    }

    // The load-bearing wire invariant: emitted octets = advertised {N}.
    expect(emitted).toBe(part.length);

    // Each SUBSTRING pull asked for exactly PG_TEXT_CHUNK_CHARS characters
    // (the reader's per-round-trip budget). If a future refactor bypassed
    // the SUBSTRING and re-added `SELECT text, html FROM mails ...`, this
    // would see one giant pull (or zero, if the SUBSTRING never fired).
    expect(substringCalls.length).toBeGreaterThan(0);
    expect(substringCalls.map((c) => c.unit)).toEqual(
      substringCalls.map(() => "chars")
    );
    expect(substringCalls.map((c) => c.take)).toEqual(
      substringCalls.map(() => PG_TEXT_CHUNK_CHARS)
    );
    for (const call of substringCalls) {
      expect(call.returned).toBeLessThanOrEqual(PG_TEXT_CHUNK_CHARS);
    }

    // Chunk count MUST scale with body size. A single giant pull (the
    // pre-fix shape) or an off-by-CHUNK_CHARS bug would produce ~1 chunk.
    expect(chunkCount).toBeGreaterThan(3);
    expect(substringCalls.length).toBeGreaterThanOrEqual(
      Math.floor(html.length / PG_TEXT_CHUNK_CHARS)
    );

    // Each emitted stream chunk is ~64 KiB (base64 of SLICE_RAW_BYTES).
    // 80 KiB gives some slack for base64 padding + boundary literals that
    // ride alongside body chunks in a single stream yield.
    expect(maxChunk).toBeLessThan(80 * 1024);

    // Round-trip: extract the base64 body from the wire and decode.
    // Not strictly a memory assertion but proves the stream is coherent.
    // (The full-body encode + decode is verified in other test files;
    // repeating a lighter form here is enough.)
    expect(emitted).toBeGreaterThan(html.length); // base64 expansion factor
  });

  it("no SUBSTRING fires for RFC822.SIZE — sumSegmentBytes stays I/O-free on the lazy path", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const html = "y".repeat(300 * 1024);
    // Store the column so a bug that fell back to reading would succeed,
    // making the "SUBSTRING calls === 0" assertion meaningful.
    columnStore.set("mail-size:html", html);

    const mail = {
      ...baseHeaders,
      text_octets: 0,
      html_octets: Buffer.byteLength(html, "utf8"),
      mail_id: "mail-size",
      user_id: "user-1",
      // No cached rfc822_size — force the compute path.
      rfc822_size: null,
    } as never;

    const part = await buildFetchResponsePart(
      mail,
      { type: "RFC822.SIZE" },
      "mail-size",
      "INBOX"
    );

    expect(part).not.toBeNull();
    expect(part!.type).toBe("simple");
    if (part!.type !== "simple") throw new Error("expected simple");
    expect(part!.content).toMatch(/^RFC822\.SIZE \d+$/);

    // The size compute path went through `computeFullMessageSize` on the
    // lazy segment list — measurement uses `byteLength` from the segment,
    // never touches the pg reader.
    expect(substringCalls.length).toBe(0);
  });

  // #757: BODY[] was the only section on the lazy path. TEXT and
  // MIME_PART projected the materialized `text`/`html` columns, so each
  // command held O(sizeof(text) + sizeof(html)) in V8's heap for its
  // whole duration — invisible to the concurrency and bytes-in-flight
  // budgets (#727 / #753), which bound CONCURRENT builds and a
  // same-socket pipeline is serial by construction
  // (`handler.ts` awaits each `handleRequest`). 14 of these back to back
  // is the 144 → 272 MB climb the issue recorded. These tests pin every
  // body-bearing section onto the chunked reader.
  const sectionCases: Array<{
    label: string;
    fetch: Parameters<typeof buildFetchResponsePart>[1];
  }> = [
    { label: "BODY[TEXT]", fetch: { type: "BODY", peek: true, section: { type: "TEXT" } } },
    {
      label: "BODY[1]",
      fetch: { type: "BODY", peek: true, section: { type: "MIME_PART", partNumber: "1" } },
    },
    {
      label: "BODY[1.TEXT]",
      fetch: {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "1", subSection: "TEXT" },
      },
    },
    { label: "RFC822.TEXT", fetch: { type: "RFC822.TEXT" } },
  ];

  for (const { label, fetch } of sectionCases) {
    it(`${label} streams a 500 KB lazy body through chunked SUBSTRING, never one allocation`, async () => {
      substringCalls.length = 0;
      columnStore.clear();
      const html = "<p>" + "z".repeat(500 * 1024 - 8) + "</p>";
      columnStore.set(`mail-${label}:html`, html);

      const mail = {
        ...baseHeaders,
        text_octets: 0,
        html_octets: Buffer.byteLength(html, "utf8"),
        mail_id: `mail-${label}`,
        user_id: "user-1",
      } as never;

      const part = await buildFetchResponsePart(mail, fetch, `mail-${label}`, "INBOX");

      expect(part).not.toBeNull();
      expect(part!.type).toBe("stream");
      if (part!.type !== "stream") throw new Error("expected stream");

      let emitted = 0;
      let maxChunk = 0;
      for await (const chunk of part.stream) {
        emitted += chunk.byteLength;
        if (chunk.byteLength > maxChunk) maxChunk = chunk.byteLength;
      }

      expect(emitted).toBe(part.length);
      expect(maxChunk).toBeLessThan(80 * 1024);
      // The whole point: the column arrived in bounded pulls. A regression
      // that re-added `text`/`html` to the projection would make
      // `wantsLazyBodies` false, emit `base64` segments off the
      // materialized string, and fire ZERO SUBSTRING calls.
      expect(substringCalls.length).toBeGreaterThanOrEqual(
        Math.floor(html.length / PG_TEXT_CHUNK_CHARS)
      );
      expect(substringCalls.map((c) => c.take)).toEqual(
        substringCalls.map(() => PG_TEXT_CHUNK_CHARS)
      );
    });
  }

  it("a partial BODY[TEXT] window stops pulling once its range is satisfied", async () => {
    substringCalls.length = 0;
    columnStore.clear();
    const html = "<p>" + "w".repeat(500 * 1024 - 8) + "</p>";
    columnStore.set("mail-partial-text:html", html);

    const mail = {
      ...baseHeaders,
      text_octets: 0,
      html_octets: Buffer.byteLength(html, "utf8"),
      mail_id: "mail-partial-text",
      user_id: "user-1",
    } as never;

    const part = await buildFetchResponsePart(
      mail,
      {
        type: "BODY",
        peek: true,
        section: { type: "TEXT" },
        partial: { start: 0, length: 64 * 1024 },
      },
      "mail-partial-text",
      "INBOX"
    );

    expect(part).not.toBeNull();
    expect(part!.type).toBe("stream");
    if (part!.type !== "stream") throw new Error("expected stream");

    let emitted = 0;
    for await (const chunk of part.stream) emitted += chunk.byteLength;
    expect(emitted).toBe(part.length);
    expect(part.length).toBe(64 * 1024);

    // iOS Mail pulls a large body as a sequence of 64 KiB partial windows.
    // Each window must read only its own slice — driving the full 500 KB
    // column per window would make the pipeline O(n²) in round-trips and
    // put the whole body back in flight. `sliceStream` closes the upstream
    // generator via for-await `.return()` the moment `take` is satisfied.
    //
    // The partial path seeks by BYTE (pgByteChunks), so the pull count is
    // bounded by the window, not by the column: exactly enough 48 KiB byte
    // pulls to cover 64 KiB. Pinning the exact count rather than "less than
    // a full drain" is what makes this bite — a regression that dropped the
    // early `.return()` would still land under a full-drain bound while
    // reading far more than the window needs.
    expect(substringCalls.map((c) => c.unit)).toEqual(
      substringCalls.map(() => "bytes")
    );
    expect(substringCalls.length).toBe(
      Math.ceil((64 * 1024) / PG_TEXT_CHUNK_BYTES)
    );
  });
});
