/**
 * Tests for fetch-helpers.ts — getRequestedFields column mapping.
 * Covers inbox #542: FETCH FLAGS must request the `answered` column so the
 * \Answered flag round-trips (STORE writes it, FETCH must read it back).
 */

import { describe, it, expect, mock } from "bun:test";

// fetch-helpers imports `logger` from "server"; stub it.
mock.module("server", () => ({
  logger: {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {})
  }
}));

import { getRequestedFields, buildBodyResponsePart } from "./fetch-helpers";
import { BodyFetch } from "./types";

describe("getRequestedFields", () => {
  describe("FLAGS", () => {
    it("requests every flag-backing column, including answered", () => {
      const fields = getRequestedFields([{ type: "FLAGS" }]);
      // \Seen, \Flagged, \Deleted, \Draft, \Answered all need their column.
      expect(fields.has("read")).toBe(true);
      expect(fields.has("saved")).toBe(true);
      expect(fields.has("deleted")).toBe(true);
      expect(fields.has("draft")).toBe(true);
      expect(fields.has("answered")).toBe(true);
    });
  });

  describe("ENVELOPE", () => {
    it("requests envelope header columns", () => {
      const fields = getRequestedFields([{ type: "ENVELOPE" }]);
      expect(fields.has("subject")).toBe(true);
      expect(fields.has("from")).toBe(true);
      expect(fields.has("messageId")).toBe(true);
    });
  });

  it("always includes uid", () => {
    expect(getRequestedFields([]).has("uid")).toBe(true);
  });

  it("unions columns across multiple data items", () => {
    const fields = getRequestedFields([{ type: "FLAGS" }, { type: "INTERNALDATE" }]);
    expect(fields.has("answered")).toBe(true);
    expect(fields.has("date")).toBe(true);
  });
});

// inbox #581: a partial BODY[...]<start.length> fetch must announce a literal
// `{N}` equal to the octets actually emitted. The bug appended a trailing CRLF
// to the partial slice without recomputing `length`, so `{N}` was 2 bytes short
// of the content — desyncing any client that reads exactly N literal octets.
describe("buildBodyResponsePart partial literal length (#581)", () => {
  // Text-only mail → BODY[TEXT] is base64(text)+CRLF, long enough to slice.
  const mail = {
    text: "The quick brown fox jumps over the lazy dog, twice over."
  };
  const textFetch = (partial?: { start: number; length: number }): BodyFetch => ({
    type: "BODY",
    peek: false,
    section: { type: "TEXT" },
    partial
  });

  it("literal length equals emitted octets for a mid-body partial slice", async () => {
    const part = await buildBodyResponsePart(mail, textFetch({ start: 0, length: 10 }), "doc1", "INBOX");
    expect(part?.type).toBe("literal");
    if (part?.type !== "literal") throw new Error("expected literal");
    // The core invariant the bug violated: {N} === actual octet count.
    expect(Buffer.byteLength(part.content, "utf8")).toBe(part.length);
    // A <0.10> partial returns exactly 10 octets — no stray trailing CRLF.
    expect(part.length).toBe(10);
    expect(part.content.endsWith("\r\n")).toBe(false);
  });

  it("literal length equals emitted octets for a non-zero start slice", async () => {
    const part = await buildBodyResponsePart(mail, textFetch({ start: 4, length: 6 }), "doc1", "INBOX");
    if (part?.type !== "literal") throw new Error("expected literal");
    expect(Buffer.byteLength(part.content, "utf8")).toBe(part.length);
    expect(part.length).toBe(6);
  });

  it("literal length equals emitted octets when the partial covers the whole body", async () => {
    const part = await buildBodyResponsePart(mail, textFetch({ start: 0, length: 100000 }), "doc1", "INBOX");
    if (part?.type !== "literal") throw new Error("expected literal");
    expect(Buffer.byteLength(part.content, "utf8")).toBe(part.length);
  });

  it("non-partial TEXT fetch still appends and counts the trailing CRLF (regression)", async () => {
    const part = await buildBodyResponsePart(mail, textFetch(), "doc1", "INBOX");
    if (part?.type !== "literal") throw new Error("expected literal");
    expect(Buffer.byteLength(part.content, "utf8")).toBe(part.length);
    expect(part.content.endsWith("\r\n")).toBe(true);
  });
});
