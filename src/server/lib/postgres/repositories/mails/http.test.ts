/**
 * The SQL these read paths emit is pinned in `http-query.test.ts`, on the
 * builders' output. What is left here is the part no emitted string can show:
 * the order `getMailHeadersDelta` does its two reads in, and what it returns
 * when one of them fails. Scoped to the one file the function lives in.
 */
import { describe, it, expect, beforeAll } from "bun:test";

describe("getMailHeadersDelta — cursor safety (#457)", () => {
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "http.ts"),
      "utf8"
    );
    const fnMatch = source.match(
      /export const getMailHeadersDelta[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getMailHeadersDelta not found in http.ts");
    // Comments restate both properties in prose; strip them so the guard is
    // about the code.
    fnSource = fnMatch[0].replace(/^\s*\/\/.*$/gm, "");
  });

  it("reads as_of before the data queries", () => {
    // Captured first, `as_of` is a safe lower bound: a row committed while the
    // data queries run is re-sent next call (at-least-once, deduped by the
    // client) rather than skipped forever. Captured after, it would skip.
    const asOfIdx = fnSource.indexOf("buildDeltaAsOfQuery(");
    const headersIdx = fnSource.indexOf("getMailHeaders(");
    expect(asOfIdx).toBeGreaterThanOrEqual(0);
    expect(headersIdx).toBeGreaterThanOrEqual(0);
    expect(asOfIdx).toBeLessThan(headersIdx);
  });

  it("awaits as_of rather than racing it against the data queries", () => {
    // Inside the Promise.all it would no longer be a lower bound.
    expect(fnSource).toMatch(/await pool\.query[\s\S]*?asOf\.sql[\s\S]*?Promise\.all/);
  });

  it("echoes `since` as as_of on failure so the cursor cannot advance", () => {
    // Returning a fresh as_of from a failed call would advance the client past
    // mutations it never received.
    expect(fnSource).toMatch(/return\s*\{\s*as_of:\s*since/);
  });
});
