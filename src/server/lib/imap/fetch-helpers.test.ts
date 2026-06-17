/**
 * Tests for fetch-helpers.ts.
 *  - getRequestedFields column mapping. Covers inbox #542: FETCH FLAGS must
 *    request the `answered` column so the \Answered flag round-trips (STORE
 *    writes it, FETCH must read it back).
 *  - buildFetchResponsePart FETCH response construction. Covers inbox #580:
 *    the ENVELOPE case must emit the RFC 3501 §7.4.2 10-field envelope (From
 *    in slot 3), not the dropped-From 11-field shape.
 */

import { describe, it, expect, mock } from "bun:test";

// fetch-helpers only pulls `logger` from the server barrel; stub it so the
// import does not drag in the full server (DB, etc.).
mock.module("server", () => ({
  logger: {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {})
  }
}));

import { getRequestedFields, buildFetchResponsePart } from "./fetch-helpers";
import { formatEnvelope } from "./util";
import type { MailType } from "common";

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

describe("buildFetchResponsePart ENVELOPE", () => {
  const mail: Partial<MailType> = {
    date: "2024-01-15T10:30:00Z",
    subject: "Hello",
    from: {
      text: "John Doe <john@example.com>",
      value: [{ name: "John Doe", address: "john@example.com" }]
    },
    to: {
      text: "Jane Roe <jane@example.com>",
      value: [{ name: "Jane Roe", address: "jane@example.com" }]
    },
    messageId: "<test@example.com>"
  };

  it("delegates to the RFC-correct formatEnvelope", async () => {
    const part = await buildFetchResponsePart(
      mail,
      { type: "ENVELOPE" },
      "doc-1",
      "INBOX"
    );
    expect(part).toEqual({
      type: "simple",
      content: `ENVELOPE ${formatEnvelope(mail)}`
    });
  });

  it("places From in slot 3, not slot 6, and keeps message-id in slot 10", async () => {
    const part = await buildFetchResponsePart(
      mail,
      { type: "ENVELOPE" },
      "doc-1",
      "INBOX"
    );
    if (part?.type !== "simple") throw new Error("expected simple part");

    // ENVELOPE (date subject (from) (sender) (reply-to) (to) (cc) (bcc)
    //           in-reply-to message-id) — RFC 3501 §7.4.2, exactly 10 fields.
    const content = part.content;
    // Slot 3 (From) sits immediately after the subject — the buggy shape put
    // `NIL NIL NIL` there and pushed From into slot 6 (the To column).
    expect(content).toContain('"Hello" (("John Doe"');
    expect(content).not.toContain('"Hello" NIL NIL NIL');
    // message-id sits in the envelope (slot 10), not dropped to NIL.
    expect(content).toContain('"<test@example.com>"');
  });
});
