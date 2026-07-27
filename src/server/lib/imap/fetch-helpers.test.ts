/**
 * Tests for fetch-helpers.ts.
 *  - getRequestedFields column mapping. Covers inbox #542 (FETCH FLAGS must
 *    request the `answered` column so the \Answered flag round-trips).
 *  - buildFetchResponsePart FETCH response construction. Covers inbox #580:
 *    the ENVELOPE case must emit the RFC 3501 §7.4.2 10-field envelope (From
 *    in slot 3), not the dropped-From 11-field shape.
 *  - convertSequenceSet normalization. Covers inbox #582: a descending
 *    seq/UID range like `3:1` must resolve the same as `1:3` (RFC 3501 §9).
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

import {
  getRequestedFields,
  buildFetchResponsePart,
  buildBodyResponsePart,
  convertSequenceSet,
} from "./fetch-helpers";
import { formatEnvelope } from "./util";
import { BodyFetch, SequenceSet } from "./types";
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

    // #667: the reply-to member of the §7.4.2 envelope needs its column
    // selected, else it always renders NIL.
    it("requests replyTo so the envelope reply-to member is populated", () => {
      expect(getRequestedFields([{ type: "ENVELOPE" }]).has("replyTo")).toBe(true);
    });
  });

  // #667: the served RFC-2822 header block must carry Reply-To when present,
  // so every body fetch that serializes headers selects the replyTo column.
  describe("replyTo column selection (#667)", () => {
    it("BODY[] (FULL) requests replyTo", () => {
      const fields = getRequestedFields([
        { type: "BODY", peek: false, section: { type: "FULL" } },
      ]);
      expect(fields.has("replyTo")).toBe(true);
    });

    it("BODY[HEADER] requests replyTo", () => {
      const fields = getRequestedFields([
        { type: "BODY", peek: true, section: { type: "HEADER" } },
      ]);
      expect(fields.has("replyTo")).toBe(true);
    });

    it("HEADER.FIELDS.NOT includes replyTo in the 'all-except' set", () => {
      const fields = getRequestedFields([
        {
          type: "BODY",
          peek: true,
          section: { type: "HEADER_FIELDS", not: true, fields: ["SUBJECT"] },
        },
      ]);
      expect(fields.has("replyTo")).toBe(true);
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

  describe("RFC822.SIZE (inbox #654)", () => {
    it("requests the full-message columns its size computation serializes", () => {
      // RFC822.SIZE is derived from the FULL-body serializer, so a bare
      // `FETCH n RFC822.SIZE` must load the header columns too — otherwise
      // formatHeaders omits those lines and the size under-reports vs BODY[].
      const size = getRequestedFields([{ type: "RFC822.SIZE" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: true, section: { type: "FULL" } }
      ]);
      expect([...size].sort()).toEqual([...body].sort());
      for (const f of [
        "text",
        "html",
        "subject",
        "from",
        "to",
        "cc",
        "bcc",
        "date",
        "messageId",
        "attachments",
      ] as const) {
        expect(size.has(f)).toBe(true);
      }
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

describe("buildFetchResponsePart bare BODY vs BODYSTRUCTURE (#666)", () => {
  const mail: Partial<MailType> = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    text: "Hello",
    attachments: [
      {
        content: { data: "att1" },
        filename: "document.pdf",
        size: 1024,
        contentType: "application/pdf"
      }
    ] as unknown as MailType["attachments"]
  };
  const docId = "doc-666";
  const mailbox = "INBOX";

  it("bare BODY emits a `BODY (...)` structure line, not BODY[] content", async () => {
    const part = await buildFetchResponsePart(
      mail,
      { type: "BODYSTRUCTURE", extensible: false },
      docId,
      mailbox
    );
    expect(part).not.toBeNull();
    // A structure line is a simple part, not a literal content download.
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      expect(part!.content.startsWith("BODY ")).toBe(true);
      expect(part!.content.startsWith("BODY[")).toBe(false);
      // Non-extensible: extension data dropped.
      expect(part!.content).not.toContain('"ATTACHMENT"');
      expect(part!.content).toContain('"mixed")');
    }
  });

  it("BODYSTRUCTURE emits a `BODYSTRUCTURE (...)` line with the extension data", async () => {
    const part = await buildFetchResponsePart(
      mail,
      { type: "BODYSTRUCTURE", extensible: true },
      docId,
      mailbox
    );
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      expect(part!.content.startsWith("BODYSTRUCTURE ")).toBe(true);
      expect(part!.content).toContain('"ATTACHMENT"');
      expect(part!.content).toContain('"mixed" NIL NIL NIL NIL)');
    }
  });
});

describe("buildFetchResponsePart RFC822.SIZE == BODY[] octet count (inbox #654)", () => {
  const docId = "doc-654";
  const mailbox = "INBOX";
  const base = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<size@local>",
    date: new Date("2026-07-07T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "size check",
  };

  // Each shape exercises a different buildFullMessage branch (single part,
  // multipart/alternative, attachments). RFC 3501 §2.3.4: RFC822.SIZE must
  // equal the octet count BODY[] returns for the same message.
  const shapes: Array<[string, Partial<MailType>]> = [
    ["text only", { ...base, text: "line one\r\nline two", html: "", attachments: [] }],
    ["html only", { ...base, text: "", html: "<p>hi there</p>", attachments: [] }],
    [
      "multipart/alternative (text+html)",
      { ...base, text: "plain body", html: "<p>rich body</p>", attachments: [] },
    ],
    [
      "with attachment",
      {
        ...base,
        text: "see attached",
        html: "",
        attachments: [
          {
            filename: "a.txt",
            contentType: "text/plain",
            size: 11,
            content: { data: "aGVsbG8gd29ybGQ=" },
          },
        ] as unknown as MailType["attachments"],
      },
    ],
    // Multibyte UTF-8: octet count != character count, so any path that
    // measured string `.length` instead of `Buffer.byteLength` would diverge.
    [
      "multibyte utf-8 (octet != char count)",
      {
        ...base,
        subject: "größe 日本語 ✉",
        text: "café ☕ 日本語 — first line\r\nemoji 😀 tail",
        html: "",
        attachments: [],
      },
    ],
  ];

  for (const [label, mail] of shapes) {
    it(`RFC822.SIZE equals BODY[] length for ${label}`, async () => {
      const size = await buildFetchResponsePart(
        mail,
        { type: "RFC822.SIZE" },
        docId,
        mailbox
      );
      const body = await buildFetchResponsePart(
        mail,
        { type: "BODY", peek: true, section: { type: "FULL" } },
        docId,
        mailbox
      );
      expect(size!.type).toBe("simple");
      expect(body!.type).toBe("literal");
      if (size!.type === "simple" && body!.type === "literal") {
        const reported = Number(size!.content.replace("RFC822.SIZE ", ""));
        expect(reported).toBe(body!.length);
      }
    });
  }
});

describe("buildBodyResponsePart header terminators (inbox #645)", () => {
  // RFC 3501 §6.4.5: every header fetch ends with exactly one RFC-2822
  // delimiting blank line after the last header field — i.e. `…field\r\n\r\n`.
  // The no-match HEADER.FIELDS case is the sole exception: a single `\r\n`.
  const mail: Partial<MailType> = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<term@local>",
    date: new Date("2026-07-03T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "Hello",
    text: "body line",
    html: "",
    attachments: []
  };
  const docId = "doc-term";
  const mailbox = "INBOX";

  const contentOf = async (fetch: BodyFetch): Promise<string> => {
    const part = await buildBodyResponsePart(mail, fetch, docId, mailbox);
    expect(part).not.toBeNull();
    if (part!.type !== "literal") throw new Error("expected literal part");
    // The advertised {N} literal must equal the emitted octets.
    expect(Buffer.byteLength(part!.content, "utf8")).toBe(part!.length);
    return part!.content;
  };

  it("BODY[HEADER] ends in exactly one delimiting blank line", async () => {
    const content = await contentOf({
      type: "BODY",
      peek: true,
      section: { type: "HEADER" }
    });
    // last field's CRLF + one blank line, and NOT a spurious second blank line.
    expect(content.endsWith("\r\n\r\n")).toBe(true);
    expect(content.endsWith("\r\n\r\n\r\n")).toBe(false);
    // sanity: the last header line is present immediately before the blank line.
    expect(content).toContain("Content-Transfer-Encoding: base64\r\n\r\n");
  });

  it("BODY[HEADER.FIELDS (...)] ends in exactly one delimiting blank line", async () => {
    const content = await contentOf({
      type: "BODY",
      peek: true,
      section: { type: "HEADER_FIELDS", fields: ["From", "Subject"], not: false }
    });
    expect(content).toContain("From: alice@example.com");
    expect(content).toContain("Subject: Hello");
    expect(content).not.toContain("To: bob@example.com"); // not requested
    expect(content.endsWith("\r\n\r\n")).toBe(true);
    expect(content.endsWith("\r\n\r\n\r\n")).toBe(false);
  });

  it("BODY[HEADER.FIELDS (no match)] is exactly a single blank line", async () => {
    const content = await contentOf({
      type: "BODY",
      peek: true,
      section: { type: "HEADER_FIELDS", fields: ["X-Nonexistent"], not: false }
    });
    expect(content).toBe("\r\n");
  });

  it("BODY[HEADER.FIELDS.NOT (...)] ends in exactly one delimiting blank line", async () => {
    // HEADER.FIELDS.NOT excludes the named fields and keeps the rest; it goes
    // through the same self-terminating HEADER_FIELDS branch, so it must also
    // end in exactly one blank line.
    const content = await contentOf({
      type: "BODY",
      peek: true,
      section: { type: "HEADER_FIELDS", fields: ["Subject"], not: true }
    });
    expect(content).not.toContain("Subject: Hello"); // excluded
    expect(content).toContain("From: alice@example.com"); // kept
    expect(content.endsWith("\r\n\r\n")).toBe(true);
    expect(content.endsWith("\r\n\r\n\r\n")).toBe(false);
  });

  it("partial fetch on BODY[HEADER] keeps {N} literal == emitted octets", async () => {
    // The partial branch slices `content` (which already carries the delimiting
    // blank line) and recomputes `length`, so the header path must not desync
    // the literal from the wire bytes.
    const part = await buildBodyResponsePart(
      mail,
      {
        type: "BODY",
        peek: true,
        section: { type: "HEADER" },
        partial: { start: 0, length: 10 }
      },
      docId,
      mailbox
    );
    expect(part).not.toBeNull();
    if (part!.type !== "literal") throw new Error("expected literal part");
    expect(Buffer.byteLength(part!.content, "utf8")).toBe(part!.length);
    expect(part!.length).toBe(10);
    expect(part!.header).toContain("<0>");
    expect(part!.header).not.toMatch(/<\d+\.\d+>/);
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
    // inbox #640: the response partial marker is the single origin octet only
    // (RFC 3501 §9 / §7.4.2 `"BODY" section ["<" number ">"]`). The request's
    // `<start.length>` form must NOT be echoed into the response.
    expect(part!.header).toContain("<0>");
    expect(part!.header).not.toContain("<0.10>");
    expect(part!.header).not.toMatch(/<\d+\.\d+>/);
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
    // inbox #640: single origin octet only — not the request's `<start.length>`.
    expect(part!.header).toContain("<5>");
    expect(part!.header).not.toContain("<5.8>");
    expect(part!.header).not.toMatch(/<\d+\.\d+>/);
  });
});

// inbox #582: RFC 3501 §9 — a seq/UID range is order-independent, so `3:1` must
// resolve to the same set as `1:3`. The unnormalized version passed the raw
// endpoints into a `uid >= start AND uid <= end` predicate, so a descending
// range produced `>= 3 AND <= 1` → matched nothing (FETCH empty / STORE NO).
const MAX = Number.MAX_SAFE_INTEGER; // the parser's expansion of `*`
const seqSet = (ranges: { start: number; end?: number }[]): SequenceSet => ({
  type: "sequence",
  ranges
});

describe("convertSequenceSet normalizes descending ranges (#582)", () => {
  it("flips a descending range to ascending (3:1 ≡ 1:3)", () => {
    expect(convertSequenceSet(seqSet([{ start: 3, end: 1 }]))).toEqual([
      { start: 1, end: 3 }
    ]);
  });

  it("leaves an ascending range unchanged (1:3)", () => {
    expect(convertSequenceSet(seqSet([{ start: 1, end: 3 }]))).toEqual([
      { start: 1, end: 3 }
    ]);
  });

  it("normalizes *:1 (MAX:1) to 1:MAX so it covers the whole mailbox", () => {
    expect(convertSequenceSet(seqSet([{ start: MAX, end: 1 }]))).toEqual([
      { start: 1, end: MAX }
    ]);
  });

  it("keeps a single number as a unit range (end defaults to start)", () => {
    expect(convertSequenceSet(seqSet([{ start: 5 }]))).toEqual([
      { start: 5, end: 5 }
    ]);
  });

  it("normalizes each range independently in a multi-range set", () => {
    expect(
      convertSequenceSet(seqSet([{ start: 5, end: 2 }, { start: 7, end: 9 }]))
    ).toEqual([
      { start: 2, end: 5 },
      { start: 7, end: 9 }
    ]);
  });
});

describe("buildBodyResponsePart MIME part sub-sections (inbox #657)", () => {
  // BODY[<part>.HEADER]/.MIME must return the part's MIME header fields; .TEXT
  // (and a bare part number) the header-less body. Before the fix all three
  // returned the base64 part body and the response was keyed BODY[<part>].
  const mail: Partial<MailType> = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<mp@local>",
    date: new Date("2026-07-08T00:00:00Z"),
    text: "Plain body",
    html: "<p>HTML body</p>",
    attachments: []
  };
  const docId = "doc-mp";
  const mailbox = "INBOX";

  const partOf = async (fetch: BodyFetch) => {
    const part = await buildBodyResponsePart(mail, fetch, docId, mailbox);
    expect(part).not.toBeNull();
    if (part!.type !== "literal") throw new Error("expected literal part");
    // The advertised {N} literal must equal the emitted octets.
    expect(Buffer.byteLength(part!.content, "utf8")).toBe(part!.length);
    return part!;
  };

  it("BODY[1.MIME] returns part 1 MIME header block, keyed BODY[1.MIME]", async () => {
    const part = await partOf({
      type: "BODY",
      peek: true,
      section: { type: "MIME_PART", partNumber: "1", subSection: "MIME" }
    });
    expect(part.header).toBe("BODY[1.MIME]");
    expect(part.content).toContain("Content-Type: text/plain; charset=utf-8");
    expect(part.content).toContain("Content-Transfer-Encoding: base64");
    // header block, not the base64 body
    expect(part.content).not.toContain(
      Buffer.from("Plain body", "utf8").toString("base64")
    );
    // exactly one delimiting blank line, no spurious second CRLF
    expect(part.content.endsWith("\r\n\r\n")).toBe(true);
    expect(part.content.endsWith("\r\n\r\n\r\n")).toBe(false);
  });

  it("BODY[1.HEADER] returns part 1 MIME header block, keyed BODY[1.HEADER]", async () => {
    const part = await partOf({
      type: "BODY",
      peek: true,
      section: { type: "MIME_PART", partNumber: "1", subSection: "HEADER" }
    });
    expect(part.header).toBe("BODY[1.HEADER]");
    expect(part.content).toContain("Content-Type: text/plain; charset=utf-8");
  });

  it("BODY[2.MIME] returns part 2 (html) MIME header block", async () => {
    const part = await partOf({
      type: "BODY",
      peek: true,
      section: { type: "MIME_PART", partNumber: "2", subSection: "MIME" }
    });
    expect(part.header).toBe("BODY[2.MIME]");
    expect(part.content).toContain("Content-Type: text/html; charset=utf-8");
  });

  it("BODY[1.TEXT] returns the header-less base64 body (same as BODY[1])", async () => {
    const b64 = Buffer.from("Plain body", "utf8").toString("base64");
    const withText = await partOf({
      type: "BODY",
      peek: true,
      section: { type: "MIME_PART", partNumber: "1", subSection: "TEXT" }
    });
    expect(withText.header).toBe("BODY[1.TEXT]");
    expect(withText.content).toContain(b64);
    expect(withText.content).not.toContain("Content-Type:");

    const bare = await partOf({
      type: "BODY",
      peek: true,
      section: { type: "MIME_PART", partNumber: "1" }
    });
    // Same body bytes, bare part is keyed without the sub-section.
    expect(bare.header).toBe("BODY[1]");
    expect(bare.content).toBe(withText.content);
  });
});

// #702 bug 2: the UID data item must draw from the domain-scoped UID space
// (uid.domain) for INBOX AND the unified "Sent Messages" folder — both resolve
// to accountName=null in resolveBox. Emitting uid.account for the unified Sent
// folder made uidToSeqNumber miss and silently dropped messages from FETCH.
describe("buildFetchResponsePart UID data item — domain-scoped UID space (#702)", () => {
  const mail: Partial<MailType> = {
    uid: { account: 7, domain: 42 } as MailType["uid"],
  };
  const docId = "doc-uid";

  it("emits uid.domain for INBOX", async () => {
    const part = await buildFetchResponsePart(mail, { type: "UID" }, docId, "INBOX");
    expect(part).toEqual({ type: "simple", content: "UID 42" });
  });

  it("emits uid.domain for the unified Sent Messages folder", async () => {
    const part = await buildFetchResponsePart(
      mail,
      { type: "UID" },
      docId,
      "Sent Messages"
    );
    expect(part).toEqual({ type: "simple", content: "UID 42" });
  });

  it("emits uid.account for an account-scoped mailbox", async () => {
    const part = await buildFetchResponsePart(
      mail,
      { type: "UID" },
      docId,
      "Sent Messages/accounts/foo"
    );
    expect(part).toEqual({ type: "simple", content: "UID 7" });
  });
});
