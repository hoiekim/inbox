/**
 * Tests for fetch-helpers.ts.
 *  - getRequestedFields column mapping. Covers inbox #542 (FETCH FLAGS must
 *    request the `answered` column so the \Answered flag round-trips) and
 *    inbox #587 (RFC822 / RFC822.HEADER / RFC822.TEXT alias BODY[] /
 *    BODY[HEADER] / BODY[TEXT] per RFC 3501 §6.4.5 — must request the same
 *    columns and emit the same bytes as their BODY[...] equivalents).
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

import { getRequestedFields, buildFetchResponsePart, buildBodyResponsePart } from "./fetch-helpers";
import { formatEnvelope } from "./util";
import { BodyFetch } from "./types";
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

  describe("RFC822 aliases (inbox #587)", () => {
    it("RFC822 requests the same columns as BODY[]", () => {
      const rfc = getRequestedFields([{ type: "RFC822" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: false, section: { type: "FULL" } }
      ]);
      expect([...rfc].sort()).toEqual([...body].sort());
      // sanity: full message needs text/html/headers/attachments columns.
      for (const f of ["text", "html", "subject", "from", "attachments"] as const) {
        expect(rfc.has(f)).toBe(true);
      }
    });

    it("RFC822.HEADER requests the same columns as BODY[HEADER]", () => {
      const rfc = getRequestedFields([{ type: "RFC822.HEADER" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: true, section: { type: "HEADER" } }
      ]);
      expect([...rfc].sort()).toEqual([...body].sort());
      expect(rfc.has("subject")).toBe(true);
      expect(rfc.has("text")).toBe(false); // header only, no body columns
    });

    it("RFC822.TEXT requests the same columns as BODY[TEXT]", () => {
      const rfc = getRequestedFields([{ type: "RFC822.TEXT" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: false, section: { type: "TEXT" } }
      ]);
      expect([...rfc].sort()).toEqual([...body].sort());
      expect(rfc.has("text")).toBe(true);
    });
  });
});

describe("buildFetchResponsePart RFC822 aliases (inbox #587)", () => {
  const mail: Partial<MailType> = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<test@local>",
    date: new Date("2026-06-21T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "hello",
    text: "body line one\r\nbody line two",
    html: "",
    attachments: []
  };
  const docId = "doc-1";
  const mailbox = "INBOX";

  it("RFC822 emits the same bytes as BODY[], labelled RFC822", async () => {
    const rfc = await buildFetchResponsePart(mail, { type: "RFC822" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: false, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(rfc).not.toBeNull();
    expect(rfc!.type).toBe("literal");
    if (rfc!.type === "literal" && body!.type === "literal") {
      expect(rfc!.content).toBe(body!.content);
      expect(rfc!.length).toBe(body!.length);
      expect(rfc!.header).toBe("RFC822");
      expect(body!.header).toBe("BODY[]");
    }
  });

  it("RFC822.HEADER emits the same bytes as BODY[HEADER], labelled RFC822.HEADER", async () => {
    const rfc = await buildFetchResponsePart(mail, { type: "RFC822.HEADER" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: true, section: { type: "HEADER" } },
      docId,
      mailbox
    );
    expect(rfc!.type).toBe("literal");
    if (rfc!.type === "literal" && body!.type === "literal") {
      expect(rfc!.content).toBe(body!.content);
      expect(rfc!.header).toBe("RFC822.HEADER");
    }
  });

  it("RFC822.TEXT emits the same bytes as BODY[TEXT], labelled RFC822.TEXT", async () => {
    const rfc = await buildFetchResponsePart(mail, { type: "RFC822.TEXT" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: false, section: { type: "TEXT" } },
      docId,
      mailbox
    );
    expect(rfc!.type).toBe("literal");
    if (rfc!.type === "literal" && body!.type === "literal") {
      expect(rfc!.content).toBe(body!.content);
      expect(rfc!.header).toBe("RFC822.TEXT");
    }
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

describe("buildBodyResponsePart — partial fetch literal length (inbox #581)", () => {
  // A long text body so a <0.10> partial is a genuine sub-range slice.
  const mail = {
    messageId: "msg-partial-test",
    text: "The quick brown fox jumps over the lazy dog, then does it all again.",
  };

  it("announces a literal length equal to the octets actually emitted", async () => {
    const fetch: BodyFetch = {
      type: "BODY",
      peek: false,
      section: { type: "TEXT" },
      partial: { start: 0, length: 10 },
    };

    const part = await buildBodyResponsePart(mail, fetch, "doc-1", "INBOX");

    expect(part).not.toBeNull();
    expect(part!.type).toBe("literal");
    if (part!.type !== "literal") throw new Error("expected literal part");
    // The {N} literal header must match the bytes that follow it on the wire;
    // before the fix the partial branch appended an uncounted CRLF, advertising
    // {10} while emitting 12 octets and desyncing the client's parse.
    expect(Buffer.byteLength(part!.content, "utf8")).toBe(part!.length);
    // A <0.10> partial returns exactly 10 octets — no trailing CRLF.
    expect(part!.length).toBe(10);
    expect(part!.header).toContain("<0.10>");
    expect(part!.content.endsWith("\r\n")).toBe(false);
  });

  it("matches literal length to emitted octets at a non-zero offset too", async () => {
    const fetch: BodyFetch = {
      type: "BODY",
      peek: false,
      section: { type: "TEXT" },
      partial: { start: 5, length: 8 },
    };

    const part = await buildBodyResponsePart(mail, fetch, "doc-1", "INBOX");

    expect(part).not.toBeNull();
    if (part!.type !== "literal") throw new Error("expected literal part");
    expect(Buffer.byteLength(part!.content, "utf8")).toBe(part!.length);
    expect(part!.length).toBe(8);
    expect(part!.header).toContain("<5.8>");
  });
});
