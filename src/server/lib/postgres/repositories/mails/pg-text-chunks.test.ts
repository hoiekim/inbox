/**
 * Offset-arithmetic tests for the mail-body pager behind `pgTextChunks`
 * (inbox #765).
 *
 * The reader pages a mail body with `SUBSTRING(<col> FROM $off FOR $take)`.
 * Postgres offsets a `text` column by CHARACTERS — one per code point —
 * while `String.prototype.length` counts UTF-16 code units, two for every
 * non-BMP character. Advancing the offset by the code-unit count overshoots
 * by exactly the number of astral characters in the chunk, dropping that
 * many characters at each boundary. Because `segmentByteLength` advertises
 * `octet_length()` in the `{N}` literal, the loss also shortens the literal
 * and desynchronizes strict IMAP clients.
 *
 * `pageByCodePoints` takes the reader as an argument, so these tests drive
 * the real loop against a Postgres-accurate fake WITHOUT `mock.module("pg")`.
 * That matters: `mock.module` is process-global in Bun
 * (reference_bun_mock_module_global_hoisting.md) and a dozen files in this
 * suite install their own pool double — the first importer of `client.ts`
 * binds it for the whole run, so a mock-based test here passes alone and
 * fails in `bun test src/server`.
 *
 * The fake below slices by CODE POINT, which is what Postgres does. The pool
 * mocks in the IMAP suites used `String.slice` (code units); that error
 * cancelled the reader's identical error, which is why their emoji
 * round-trip test passed against a stream that dropped characters in prod.
 */

import { describe, it, expect } from "bun:test";
import { pageByCodePoints, PG_TEXT_CHUNK_CHARS } from "./imap";

/**
 * `SUBSTRING(col FROM offset FOR take)` over a JS string: 1-indexed,
 * counting code points, "" once offset is past the end.
 */
const postgresLikeReader = (stored: string, calls: number[]) =>
  async (offset: number, take: number): Promise<string> => {
    calls.push(offset);
    const codePoints = [...stored];
    const start = Math.max(0, offset - 1);
    return codePoints.slice(start, start + take).join("");
  };

const drain = async (stored: string, chunkChars: number) => {
  const offsets: number[] = [];
  const parts: string[] = [];
  for await (const chunk of pageByCodePoints(postgresLikeReader(stored, offsets), chunkChars)) {
    parts.push(chunk);
  }
  return { out: parts.join(""), offsets };
};

describe("pageByCodePoints reassembles the column exactly (#765)", () => {
  it("round-trips a pure-ASCII column (control — passes with either offset unit)", async () => {
    const body = "abcdefghij".repeat(50); // 500 chars, no astral
    const { out, offsets } = await drain(body, 100);
    expect(out).toBe(body);
    expect(offsets.slice(0, 5)).toEqual([1, 101, 201, 301, 401]);
  });

  it("round-trips a column whose chunks contain astral characters", async () => {
    // Each 🙂 is ONE Postgres character but TWO UTF-16 code units. With 4
    // per 12-code-point group, a 100-character chunk overshoots by ~33 code
    // units under the old arithmetic — that many characters silently
    // skipped at every boundary.
    const body = "ab🙂cd🙂ef🙂gh🙂".repeat(60); // 720 code points
    const { out, offsets } = await drain(body, 100);

    expect(out).toBe(body);
    // The literal-length invariant: what the stream emits must equal the
    // octet count `octet_length()` reports, which is what `{N}` advertises.
    expect(Buffer.byteLength(out, "utf8")).toBe(Buffer.byteLength(body, "utf8"));
    // Offsets must advance by CODE POINTS (100), not code units (which
    // would be 100 + astralCount and would leave gaps).
    expect(offsets.slice(0, 5)).toEqual([1, 101, 201, 301, 401]);
  });

  it("does not drop the character sitting exactly on a chunk boundary", async () => {
    const body = "x".repeat(9) + "🙂" + "y".repeat(9) + "🙂" + "z".repeat(9);
    const { out } = await drain(body, 10);
    expect(out).toBe(body);
    expect([...out].length).toBe([...body].length);
  });

  it("terminates on a final chunk that is short in CODE POINTS", async () => {
    // 12 code points / 16 code units at chunkChars = 16: the old check
    // (`chunk.length < chunkChars`) sees 16 and keeps paging; the
    // code-point check sees 12 and stops.
    const body = "ab🙂cd🙂ef🙂gh🙂";
    const { out, offsets } = await drain(body, 16);
    expect(out).toBe(body);
    expect(offsets.length).toBe(1);
  });

  it("handles a column that is entirely astral characters", async () => {
    const body = "🙂".repeat(250); // 250 code points, 500 code units
    const { out, offsets } = await drain(body, 100);
    expect(out).toBe(body);
    expect(Buffer.byteLength(out, "utf8")).toBe(1000); // 4 bytes each
    expect(offsets.slice(0, 3)).toEqual([1, 101, 201]);
  });

  it("mixes multi-byte BMP and astral characters without drift", async () => {
    // café (BMP accents, 2 bytes) + ☕/日本語 (3 bytes) + 😀 (astral, 4
    // bytes). Only the astral char costs two code units — the BMP
    // multi-byte characters are a control showing byte-length alone is not
    // the confusion.
    const body = "café ☕ 日本語 😀 ".repeat(500);
    const { out } = await drain(body, PG_TEXT_CHUNK_CHARS);
    expect(out).toBe(body);
    expect(Buffer.byteLength(out, "utf8")).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("returns nothing for an absent column without paging forever", async () => {
    const { out, offsets } = await drain("", 100);
    expect(out).toBe("");
    expect(offsets.length).toBe(1);
  });

  it("stops after one read when the column is exactly one short chunk", async () => {
    const body = "abc";
    const { out, offsets } = await drain(body, 100);
    expect(out).toBe(body);
    expect(offsets).toEqual([1]);
  });
});
