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

import { describe, it, expect, mock, afterAll } from "bun:test";
import fs from "node:fs";
import {
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachment
} from "../mails/util";

// Stub the server barrel so the import does not drag in the full server (DB,
// etc.). `mock.module` is process-global in Bun and reaches the leaf module the
// barrel re-exports, so the attachment helpers are forwarded VERBATIM rather
// than redirected — swapping ATTACHMENT_FOLDER for a temp dir here broke
// mails/util.test.ts's constant assertions in the same run.
mock.module("server", () => ({
  logger: {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {})
  },
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachment
}));

// Attachment bodies are measured (stat) and read from the same path, so these
// tests write real files under the real folder and remove exactly those.
const TEST_ID_PREFIX = "fetch-helpers-test-";
const attachmentPath = (id: string) => getAttachmentFilePath(TEST_ID_PREFIX + id);
const writtenIds = new Set<string>();
const writeAttachment = (id: string, data: Buffer): Buffer => {
  fs.mkdirSync(ATTACHMENT_FOLDER, { recursive: true });
  fs.writeFileSync(attachmentPath(id), data);
  writtenIds.add(id);
  return data;
};

import {
  getRequestedFields,
  addBodyFields,
  buildFetchResponsePart,
  buildBodyResponsePart,
  convertSequenceSet,
  FetchResponsePart,
  FetchRequestedField,
  FetchMailInput,
} from "./fetch-helpers";
import { formatEnvelope } from "./util";
import { BodyFetch, SequenceSet } from "./types";
import {
  withBodyBudget,
  bodyBudgetCapacity,
  _resetBodyBudget
} from "./body-budget";
import type { MailType } from "common";

afterAll(() => {
  for (const id of writtenIds) fs.rmSync(attachmentPath(id), { force: true });
});

// Wire content is `string | Buffer` — the residual materialized paths
// (partial non-FULL, header-like sections) land as Buffer. Every test in
// this file reasons about them as UTF-8 text, so coerce at the boundary.
const contentAsString = (
  part: Extract<FetchResponsePart, { type: "literal" }>
): string =>
  Buffer.isBuffer(part.content) ? part.content.toString("utf8") : part.content;

// Stream parts don't materialize a `.content` field — iterate the async
// generator to collect chunks, concat, and stringify. Tests treat both
// shapes uniformly; the wire bytes are what matters.
const contentAsStringAny = async (
  part: FetchResponsePart
): Promise<string> => {
  if (part.type === "simple") return part.content;
  if (part.type === "literal") return contentAsString(part);
  const chunks: Buffer[] = [];
  for await (const chunk of part.stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

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
      // sanity: full-message stream needs headers + attachments AND the
      // four synthetic streaming fields (text_octets / html_octets +
      // mail_id / user_id) that drive the pg SUBSTRING body stream. The
      // raw `text`/`html` strings are deliberately NOT requested — loading
      // multi-MB columns per FETCH is the OOM path this stream fixed.
      for (const f of [
        "text_octets",
        "html_octets",
        "mail_id",
        "user_id",
        "subject",
        "from",
        "attachments",
      ] as const) {
        expect(rfc.has(f)).toBe(true);
      }
      expect(rfc.has("text")).toBe(false);
      expect(rfc.has("html")).toBe(false);
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
      // Post-cache-deletion: TEXT projects BOTH materialized (text/html)
      // AND lazy synthetics. The materialized shape is needed by the
      // partial-fetch fall-through path (`getBodyContent → buildFullMessage`)
      // and by `getBodyPartHeaders` for `.MIME` / `.HEADER` sub-sections;
      // the lazy synthetics carry the segment metadata for the streaming
      // branches. `wantsLazyBodies` reads text-undefined so the streaming
      // path emits `base64` segments (materialized source, chunk-bounded
      // output) rather than `lazy-text` (pgTextChunks) — this trades the
      // lazy-segment memory win for correctness across all fall-through
      // paths.
      expect(rfc.has("text")).toBe(true);
      expect(rfc.has("html")).toBe(true);
      expect(rfc.has("text_octets" as FetchRequestedField)).toBe(true);
      expect(rfc.has("html_octets" as FetchRequestedField)).toBe(true);
      expect(rfc.has("mail_id" as FetchRequestedField)).toBe(true);
      expect(rfc.has("user_id" as FetchRequestedField)).toBe(true);
    });
  });

  describe("RFC822.SIZE (inbox #654)", () => {
    it("requests the full-message columns its size computation serializes, plus the cached column", () => {
      // RFC822.SIZE is derived from the FULL-body serializer, so a bare
      // `FETCH n RFC822.SIZE` must load the header columns too — otherwise
      // formatHeaders omits those lines and the size under-reports vs BODY[].
      // Post-#729: also request `rfc822_size` (the cached-column short-circuit)
      // so the fetch handler can skip buildFullMessage when the value is
      // already persisted. The set is a STRICT SUPERSET of BODY[]'s.
      const size = getRequestedFields([{ type: "RFC822.SIZE" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: true, section: { type: "FULL" } }
      ]);
      // Every BODY[] field must be present for the fallback compute path
      // (first observation of a mail — cached column is NULL).
      for (const f of body) {
        expect(size.has(f)).toBe(true);
      }
      // Plus the cached-column short-circuit.
      expect(size.has("rfc822_size" as never)).toBe(true);
      // And no other fields — the difference is exactly one column.
      expect(size.size).toBe(body.size + 1);
      for (const f of [
        "text_octets",
        "html_octets",
        "mail_id",
        "user_id",
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
      // The raw text/html columns are NOT requested — the size compute
      // path also uses the streaming fields via computeFullMessageSize on
      // a lazy segment list (measurement is pure math on `byteLength`).
      expect(size.has("text")).toBe(false);
      expect(size.has("html")).toBe(false);
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
    // Both RFC822 and BODY[] FULL route through the stream part after
    // Length + wire bytes match; only the header label differs.
    expect(rfc!.type === "stream" || rfc!.type === "literal").toBe(true);
    expect(body!.type === "stream" || body!.type === "literal").toBe(true);
    if (
      (rfc!.type === "literal" || rfc!.type === "stream") &&
      (body!.type === "literal" || body!.type === "stream")
    ) {
      expect(await contentAsStringAny(rfc!)).toBe(await contentAsStringAny(body!));
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
      // Compare octets, not identity — the two paths are labeled
      // differently (RFC822.HEADER vs BODY[HEADER]) but must produce
      // identical wire bytes.
      expect(contentAsString(rfc)).toBe(contentAsString(body));
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
    // Post-cache-deletion: TEXT + RFC822.TEXT both route through the
    // segment-walk streamer. Drain the stream to cross-check bytes
    // instead of comparing `content`.
    expect(rfc!.type).toBe("stream");
    expect(body!.type).toBe("stream");
    if (rfc!.type === "stream" && body!.type === "stream") {
      const drain = async (s: AsyncIterable<Buffer>): Promise<Buffer> => {
        const chunks: Buffer[] = [];
        for await (const c of s) chunks.push(c);
        return Buffer.concat(chunks as unknown as Uint8Array[]);
      };
      const [rfcBytes, bodyBytes] = await Promise.all([
        drain(rfc.stream),
        drain(body.stream),
      ]);
      expect(rfcBytes.equals(bodyBytes as unknown as Uint8Array)).toBe(true);
      expect(rfc.header).toBe("RFC822.TEXT");
      expect(rfc.length).toBe(body.length);
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
    // The has-text / has-html predicates use `.trim()` while the emit uses the
    // untrimmed source, so a whitespace-only part is the shape where a
    // measure/emit split would show up.
    ["whitespace-only text", { ...base, text: "   \r\n  ", html: "", attachments: [] }],
    [
      "whitespace-only text with real html",
      { ...base, text: "   ", html: "<p>rich</p>", attachments: [] }
    ],
    ["whitespace-only text and html", { ...base, text: "  ", html: "   ", attachments: [] }],
    ["no body at all", { ...base, text: "", html: "", attachments: [] }],
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
    it(`RFC822.SIZE equals the octets BODY[] actually emits for ${label}`, async () => {
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
      // A FULL section is deterministically a stream part; accepting "literal"
      // here would also pass if the branch silently fell back, which is the
      // regression most worth catching.
      expect(body!.type).toBe("stream");
      if (size!.type !== "simple" || body!.type !== "stream") return;

      const reported = Number(size!.content.replace("RFC822.SIZE ", ""));
      expect(reported).toBe(body!.length);

      // The load-bearing assertion. Comparing `reported` to `body.length` alone
      // is a tautology — both read `computeFullMessageSize`. Only draining the
      // generator proves the `{N}` literal matches the octets that arrive; a
      // mismatch desyncs every later response on the connection.
      let emitted = 0;
      for await (const chunk of body!.stream) emitted += chunk.byteLength;
      expect(emitted).toBe(reported);
    });
  }
});

describe("BODY[] {N} holds when the attachment file disagrees with the mail row", () => {
  // The shapes above all have stored sizes that happen to match. These are the
  // ones that diverge: the literal count is advertised before a single byte is
  // read, so anything derived from the stored `size` while the payload comes
  // from disk can desync the stream.
  const docId = "doc-divergent";
  const mailbox = "INBOX";
  const base = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<divergent@local>",
    date: new Date("2026-07-30T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "divergent",
    text: "see attached",
    html: ""
  };

  /** attachments field for an already-prefixed attachment id. */
  const attList = (prefixedId: string) => ({
    attachments: [
      {
        filename: "a.bin",
        contentType: "application/octet-stream",
        size: 60_000,
        content: { data: prefixedId }
      }
    ] as unknown as MailType["attachments"]
  });

  const withAttachment = (id: string, storedSize: number): Partial<MailType> => ({
    ...base,
    attachments: [
      {
        filename: "a.bin",
        contentType: "application/octet-stream",
        size: storedSize,
        content: { data: TEST_ID_PREFIX + id }
      }
    ] as unknown as MailType["attachments"]
  });

  /** The base64 payload the wire carried for `filename`, decoded. */
  const decodePart = (wire: string, filename: string): Buffer => {
    const marker = `filename="${filename}"\r\n\r\n`;
    const start = wire.indexOf(marker);
    if (start === -1) throw new Error(`part ${filename} not on the wire`);
    const from = start + marker.length;
    const end = wire.indexOf("\r\n--", from);
    return Buffer.from(wire.slice(from, end === -1 ? undefined : end), "base64");
  };

  const drain = async (mail: Partial<MailType>) => {
    const size = await buildFetchResponsePart(mail, { type: "RFC822.SIZE" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: true, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(size!.type).toBe("simple");
    expect(body!.type).toBe("stream");
    if (size!.type !== "simple" || body!.type !== "stream") throw new Error("shape");
    const reported = Number(size!.content.replace("RFC822.SIZE ", ""));
    const parts: Buffer[] = [];
    let emitted = 0;
    for await (const chunk of body!.stream) {
      emitted += chunk.byteLength;
      parts.push(Buffer.from(chunk));
    }
    const wire = Buffer.concat(parts).toString("utf8");
    return { reported, declared: body!.length, emitted, wire };
  };

  it("stored size LARGER than the file on disk", async () => {
    const id = "att-too-big";
    const original = Buffer.alloc(1024, 7);
    writeAttachment(id, original);
    const { reported, declared, emitted, wire } = await drain(withAttachment(id, 999_999));
    expect(emitted).toBe(reported);
    expect(emitted).toBe(declared);
    // The count holding is not enough: measuring the stored size while emitting
    // the file pads the payload out to a size the attachment never had, so the
    // client decodes a corrupt attachment. The size must follow the file.
    expect(decodePart(wire, "a.bin").equals(original)).toBe(true);
  });

  it("stored size SMALLER than the file on disk", async () => {
    const id = "att-too-small";
    const original = Buffer.alloc(200_000, 9);
    writeAttachment(id, original);
    const { reported, declared, emitted, wire } = await drain(withAttachment(id, 11));
    expect(emitted).toBe(reported);
    expect(emitted).toBe(declared);
    // Understating the size truncates the attachment mid-stream.
    expect(decodePart(wire, "a.bin").equals(original)).toBe(true);
  });

  it("segment list is built ONCE per BODY[] fetch — length + stream cannot desync (#733 reviewoie HIGH)", async () => {
    // Reproduces the reviewoie HIGH: the stream side previously called
    // `buildMessageSegments` independently from `computeFullMessageSize`,
    // so each pass ran its own `fs.statSync` on the attachment. If the
    // file grew between the two stats, `{N}` (from the first) < emitted
    // bytes (from the second), corrupting the wire literal — reviewoie
    // reproduced "declared 1833, emitted 67165". Fix hoisted segments to
    // the caller so both size + stream derive from ONE list.
    //
    // The fix hoists `buildMessageSegments` to `buildBodyResponsePart`
    // so ONE list drives both measurement and emit. This test proves it
    // by growing the file AFTER the fetch part is constructed (which
    // freezes the segment list) but BEFORE the stream drains — before
    // the fix, the stream would `stat` the grown file and emit more
    // bytes than declared. After the fix, the emit is clamped by the
    // segment's stored `rawSize`.
    const id = "att-grows-mid-fetch";
    const initial = Buffer.alloc(1024, 7);
    writeAttachment(id, initial);
    const mail = withAttachment(id, 1024);
    const part = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: true, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(part!.type).toBe("stream");
    if (part!.type !== "stream") throw new Error("shape");
    const declared = part.length;

    // Grow the file well past the initial size. If segments were
    // re-built inside the stream, this would leak into the emit.
    const grown = Buffer.alloc(64 * 1024, 9);
    fs.writeFileSync(attachmentPath(id), grown);

    let emitted = 0;
    for await (const chunk of part.stream) emitted += chunk.byteLength;
    expect(emitted).toBe(declared);
  });

  it("stored size zero (Attachment ctor default for a falsy incoming size)", async () => {
    const id = "att-zero";
    const original = Buffer.alloc(50_000, 3);
    writeAttachment(id, original);
    const { reported, emitted, wire } = await drain(withAttachment(id, 0));
    expect(emitted).toBe(reported);
    expect(decodePart(wire, "a.bin").equals(original)).toBe(true);
  });

  it("attachment file missing entirely", async () => {
    const { reported, declared, emitted } = await drain(
      withAttachment("att-does-not-exist", 1_398_738)
    );
    expect(emitted).toBe(reported);
    expect(emitted).toBe(declared);
    expect(Number.isFinite(reported)).toBe(true);
  });

  it("stored size undefined does not advertise NaN", async () => {
    const id = "att-undef-size";
    writeAttachment(id, Buffer.alloc(4096, 1));
    const mail: Partial<MailType> = {
      ...base,
      attachments: [
        {
          filename: "a.bin",
          contentType: "application/octet-stream",
          content: { data: TEST_ID_PREFIX + id }
        }
      ] as unknown as MailType["attachments"]
    };
    const { reported, emitted, wire } = await drain(mail);
    expect(Number.isNaN(reported)).toBe(false);
    expect(emitted).toBe(reported);
    expect(decodePart(wire, "a.bin").equals(Buffer.alloc(4096, 1))).toBe(true);
  });

  it("multiple attachments, mixed present and missing", async () => {
    const present = "att-multi-present";
    writeAttachment(present, Buffer.alloc(120_000, 5));
    const mail: Partial<MailType> = {
      ...base,
      attachments: [
        {
          filename: "present.bin",
          contentType: "application/octet-stream",
          size: 120_000,
          content: { data: TEST_ID_PREFIX + present }
        },
        {
          filename: "gone.bin",
          contentType: "application/octet-stream",
          size: 777_777,
          content: { data: TEST_ID_PREFIX + "att-multi-missing" }
        }
      ] as unknown as MailType["attachments"]
    };
    const { reported, emitted, wire } = await drain(mail);
    expect(emitted).toBe(reported);
    expect(decodePart(wire, "present.bin").equals(Buffer.alloc(120_000, 5))).toBe(true);
  });

  // MED 4 in review: the MIME layout used to be hand-parallel across the
  // measure/emit/materialize functions, so a shape covered by only one of them
  // could drift. These walk every branch of the layout with a real file on disk.
  const layoutShapes: Array<[string, (id: string) => Partial<MailType>]> = [
    [
      "text + html + attachment (alternative nested in mixed)",
      (id) => ({ ...base, text: "plain", html: "<p>rich</p>", ...attList(id) })
    ],
    ["html + attachment", (id) => ({ ...base, text: "", html: "<p>rich</p>", ...attList(id) })],
    ["attachment only", (id) => ({ ...base, text: "", html: "", ...attList(id) })],
    [
      "multibyte text + attachment",
      (id) => ({ ...base, text: "café ☕ 日本語 😀", html: "", ...attList(id) })
    ]
  ];

  for (const [label, make] of layoutShapes) {
    it(`{N} matches emitted octets for ${label}`, async () => {
      const id = `att-layout-${label.replace(/[^a-z]/gi, "")}`;
      const original = Buffer.alloc(60_000, 11);
      writeAttachment(id, original);
      const { reported, declared, emitted, wire } = await drain(
        make(TEST_ID_PREFIX + id) as Partial<MailType>
      );
      expect(emitted).toBe(reported);
      expect(emitted).toBe(declared);
      expect(decodePart(wire, "a.bin").equals(original)).toBe(true);
    });
  }

  it("a multi-slice attachment round-trips byte-for-byte", async () => {
    // A 200 KB attachment crosses several 48 KiB slice boundaries. If the slice
    // size were not divisible by 3, base64 would inject '=' padding mid-stream
    // and the decode would not match — corrupting the payload for the client on
    // top of breaking the ceil(n/3)*4 total the literal advertises.
    const id = "att-slice-boundary";
    const original = Buffer.alloc(200_000);
    for (let i = 0; i < original.length; i += 1) original[i] = i % 251;
    writeAttachment(id, original);

    const body = await buildFetchResponsePart(
      withAttachment(id, original.length),
      { type: "BODY", peek: true, section: { type: "FULL" } },
      docId,
      mailbox
    );
    if (body?.type !== "stream") throw new Error("expected stream");
    const parts: Buffer[] = [];
    for await (const chunk of body.stream) parts.push(Buffer.from(chunk));
    const wire = Buffer.concat(parts).toString("utf8");

    const marker = `filename="a.bin"\r\n\r\n`;
    const start = wire.indexOf(marker) + marker.length;
    const end = wire.indexOf("\r\n--", start);
    expect(start).toBeGreaterThan(marker.length - 1);
    expect(end).toBeGreaterThan(start);
    const encoded = wire.slice(start, end);
    expect(encoded.length).toBe(Math.ceil(original.length / 3) * 4);
    expect(Buffer.from(encoded, "base64").equals(original)).toBe(true);
  });
});

describe("buildFetchResponsePart BODY[] streams without materializing", () => {
  // FULL sections yield Buffer chunks straight to the writer, so peak transient
  // allocation stays bounded by the chunk size rather than the body size.

  const docId = "doc-stream";
  const mailbox = "INBOX";
  const base = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<stream@local>",
    date: new Date("2026-07-30T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "stream",
    text: "plain body",
    html: "<p>rich body</p>",
    attachments: [] as unknown as MailType["attachments"],
  };

  it("BODY[] returns a stream part with pre-computed length", async () => {
    const body = await buildFetchResponsePart(
      base,
      { type: "BODY", peek: false, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(body).not.toBeNull();
    expect(body!.type).toBe("stream");
    if (body!.type === "stream") {
      expect(body!.length).toBeGreaterThan(0);
      expect(body!.header).toBe("BODY[]");
      // Sum of chunk byte-lengths equals the declared `length`. Load-
      // bearing: without this invariant, the IMAP `{N}` literal would
      // desync from the octet count that arrives, corrupting the wire
      // response.
      let seen = 0;
      for await (const chunk of body!.stream) {
        expect(Buffer.isBuffer(chunk)).toBe(true);
        seen += chunk.byteLength;
      }
      expect(seen).toBe(body!.length);
    }
  });

  it("stream chunks stay small for a LARGE body, not just a small one", async () => {
    // The previous version of this test used a 10-byte body, so its 256 KiB
    // ceiling could never fire. Sizing text and html into the megabytes is what
    // makes the assertion mean anything: an unchunked part yields one Buffer of
    // ~4/3 the source size and fails here.
    const large = {
      ...base,
      text: "t".repeat(4 * 1024 * 1024),
      html: `<p>${"h".repeat(4 * 1024 * 1024)}</p>`
    };
    const body = await buildFetchResponsePart(
      large,
      { type: "BODY", peek: false, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(body!.type).toBe("stream");
    if (body!.type !== "stream") return;

    const maxChunk = 256 * 1024;
    let chunks = 0;
    let biggest = 0;
    let emitted = 0;
    for await (const chunk of body!.stream) {
      chunks += 1;
      biggest = Math.max(biggest, chunk.byteLength);
      emitted += chunk.byteLength;
    }
    expect(biggest).toBeLessThanOrEqual(maxChunk);
    expect(chunks).toBeGreaterThan(100);
    expect(emitted).toBe(body!.length);
  });

  // The budget tests below deliberately saturate capacity BEFORE starting the
  // stream. Asserting only "capacity is free after draining" would pass whether
  // or not the stream ever acquired a slot — the same vacuous shape this file's
  // size assertions used to have.
  const saturateAllButOne = () => {
    const releases: Array<() => void> = [];
    const held = Array.from({ length: bodyBudgetCapacity() - 1 }, () =>
      withBodyBudget(() => new Promise<void>((resolve) => releases.push(resolve)))
    );
    return { releases, held };
  };

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  const startStream = async () => {
    const body = await buildFetchResponsePart(
      base,
      { type: "BODY", peek: false, section: { type: "FULL" } },
      docId,
      mailbox
    );
    if (body?.type !== "stream") throw new Error("expected stream");
    const iterator = body.stream[Symbol.asyncIterator]();
    // The first `next()` is what awaits the budget acquire.
    await iterator.next();
    return iterator;
  };

  it("holds a budget slot while the stream is in flight", async () => {
    _resetBodyBudget();
    const { releases, held } = saturateAllButOne();
    const iterator = await startStream();

    // The stream now owns the last slot, so a further acquire must wait.
    let extraRan = false;
    const pending = withBodyBudget(async () => {
      extraRan = true;
    });
    await flush();
    expect(extraRan).toBe(false);

    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
    }
    await pending;
    expect(extraRan).toBe(true);

    releases.forEach((release) => release());
    await Promise.all(held);
  });

  it("releases the slot when the consumer abandons the stream early", async () => {
    _resetBodyBudget();
    const { releases, held } = saturateAllButOne();
    const iterator = await startStream();

    let extraRan = false;
    const pending = withBodyBudget(async () => {
      extraRan = true;
    });
    await flush();
    expect(extraRan).toBe(false);

    // Mirrors writeStreamToSocket breaking out on a dead socket: the generator's
    // finally must run and hand the slot back, or an aborted FETCH leaks it.
    await iterator.return?.(undefined);
    await pending;
    expect(extraRan).toBe(true);

    releases.forEach((release) => release());
    await Promise.all(held);
  });
});

describe("getRequestedFields BODYSTRUCTURE cached-column projection (#740)", () => {
  // The load-bearing invariant. BODYSTRUCTURE's projection MUST NOT include
  // `text` / `html` after #740 — a bare `UID FETCH X BODYSTRUCTURE` was
  // materializing multi-MB text/html per UID just to derive the `lines`
  // field. Projection is now the pre-measured octet counts + persisted
  // line-count columns (metadata-only); the cache-miss fallback loads
  // text/html per row only when the persisted column is NULL.
  it("projects text_octets + html_octets + line-count columns, NOT text/html", () => {
    const fields = getRequestedFields([
      { type: "BODYSTRUCTURE", extensible: true },
    ]);
    for (const f of [
      "text_octets",
      "html_octets",
      "mail_id",
      "user_id",
      "text_line_count",
      "html_line_count",
      "attachments",
    ] as const) {
      expect(fields.has(f as FetchRequestedField)).toBe(true);
    }
    // The load-bearing negative — dropping these two is the whole point.
    expect(fields.has("text")).toBe(false);
    expect(fields.has("html")).toBe(false);
  });

  it("bare BODY (extensible=false) projects the same columns as BODYSTRUCTURE", () => {
    // RFC 3501 §6.4.5: `BODY` is `BODYSTRUCTURE` minus the extension tail —
    // same structure, same source columns. Both must skip text/html the
    // same way.
    const bare = getRequestedFields([
      { type: "BODYSTRUCTURE", extensible: false },
    ]);
    const ext = getRequestedFields([
      { type: "BODYSTRUCTURE", extensible: true },
    ]);
    expect([...bare].sort()).toEqual([...ext].sort());
  });
});

describe("buildFetchResponsePart BODYSTRUCTURE cached-column short-circuit (#740)", () => {
  const docId = "doc-bs-cached";
  const mailbox = "INBOX";
  const base = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<bs-cached@local>",
    date: new Date("2026-07-31T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "bs-cached",
    attachments: [],
  };

  it("derives size from the cached octet column without loading text/html", async () => {
    // The load-bearing case. Row carries the lazy projection shape only
    // — `text_octets` (raw octet count). Neither `text` nor `html` string
    // is on the mail, so formatBodyStructure MUST NOT reach for them. If
    // the cached path were bypassed and buildTextPart fell through to
    // encoding the absent string, `size` would come out as 0 — not 44.
    // `lines` is 1 on both paths: it measures the unfolded-base64 body
    // the server actually serves, not the decoded text (RFC 3501 §7.4.2).
    const mailWithCache: FetchMailInput = {
      ...base,
      text_octets: 33, // 33 raw bytes → base64 encodes to ceil(33/3)*4 = 44
      html_octets: 0,
      text_line_count: 42,
      html_line_count: 0,
    };
    const part = await buildFetchResponsePart(
      mailWithCache,
      { type: "BODYSTRUCTURE", extensible: true },
      docId,
      mailbox
      // userId omitted intentionally: no persist step should fire on a hit.
    );
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      // Single text part shape — no HTML, no attachments.
      // Format: (TEXT PLAIN ("CHARSET" "UTF-8") NIL NIL BASE64 <size> <lines>)
      expect(part!.content).toContain('"TEXT" "PLAIN"'.replace(/"/g, ""));
      expect(part!.content).toContain("BASE64 44 1");
    }
  });

  it("emits multipart/alternative from cached octets for a text+html mail with no strings loaded", async () => {
    const mailWithCache: FetchMailInput = {
      ...base,
      text_octets: 6, // → base64 8
      html_octets: 15, // → base64 20
      text_line_count: 2,
      html_line_count: 5,
    };
    const part = await buildFetchResponsePart(
      mailWithCache,
      { type: "BODYSTRUCTURE", extensible: true },
      docId,
      mailbox
    );
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      // Both parts + the alternative wrapper. Both sizes must derive from
      // cache (no strings on mail — would be 0 on a materialized fallback).
      expect(part!.content).toContain("BASE64 8 1");
      expect(part!.content).toContain("BASE64 20 1");
      expect(part!.content).toContain('"alternative"');
    }
  });

  it("materialized-caller shape (mail.text / mail.html as strings) still works — same size + lines", async () => {
    // The util.test.ts + cache-miss fallback caller shape. When the strings
    // ARE loaded, formatBodyStructure base64+splits them the same way it
    // has always done. Same wire bytes as the cached path for the same
    // input, so callers can be mixed without divergence.
    const materialized: Partial<MailType> = {
      ...base,
      text: "line one\r\nline two\r\nline three",
      html: "",
    };
    const cachedEquivalent: FetchMailInput = {
      ...base,
      // Same octets (materialized string is 30 bytes) + same line count (3).
      text_octets: Buffer.byteLength("line one\r\nline two\r\nline three", "utf8"),
      html_octets: 0,
      text_line_count: 3,
      html_line_count: 0,
    };
    const mat = await buildFetchResponsePart(
      materialized,
      { type: "BODYSTRUCTURE", extensible: true },
      docId,
      mailbox
    );
    const cached = await buildFetchResponsePart(
      cachedEquivalent,
      { type: "BODYSTRUCTURE", extensible: true },
      docId,
      mailbox
    );
    expect(mat!.type).toBe("simple");
    expect(cached!.type).toBe("simple");
    if (mat!.type === "simple" && cached!.type === "simple") {
      expect(mat!.content).toBe(cached!.content);
    }
  });

  it("cache miss without userId falls through — uses whatever's on the mail (no persist attempted)", async () => {
    // The cache-miss branch is guarded by `userId`: without one there's
    // no target row to write back to, so the handler skips the fallback
    // load AND the persist. Assert the emit still succeeds (falls back to
    // the materialized shape when strings ARE present, or to 0/1 defaults
    // when nothing at all is loaded).
    const mailNoUser: Partial<MailType> = {
      ...base,
      text: "hi",
      html: "",
    };
    const part = await buildFetchResponsePart(
      mailNoUser,
      { type: "BODYSTRUCTURE", extensible: true },
      docId,
      mailbox
      // userId omitted intentionally
    );
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      expect(part!.content.startsWith("BODYSTRUCTURE ")).toBe(true);
    }
  });
});

describe("buildFetchResponsePart RFC822.SIZE cached-column short-circuit (#729)", () => {
  const docId = "doc-cached";
  const mailbox = "INBOX";
  const base = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<cached@local>",
    date: new Date("2026-07-30T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "cached",
    text: "irrelevant — buildFullMessage MUST NOT run when rfc822_size is set",
    html: "",
    attachments: [],
  };

  it("returns the cached column value verbatim without calling buildFullMessage", async () => {
    // The load-bearing invariant. When `mail.rfc822_size` is set (populated
    // by getMailsByRange's SELECT for a previously-observed mail), the
    // fetch handler skips the FULL-body serializer entirely — no
    // buildFullMessage call, no attachment materialization, no ~100MB
    // allocation. We prove this by setting the cached value to a number
    // that DOES NOT match what buildFullMessage would produce; if the
    // handler fell through to compute, the returned value would differ.
    const mailWithCache: Partial<MailType> = {
      ...base,
      rfc822_size: 999_999_999,
    };
    const part = await buildFetchResponsePart(
      mailWithCache,
      { type: "RFC822.SIZE" },
      docId,
      mailbox
    );
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      expect(part!.content).toBe("RFC822.SIZE 999999999");
    }
  });

  it("falls through to compute when rfc822_size is null (not yet populated)", async () => {
    // The DB stores NULL for rows that haven't been observed yet. Handler
    // must fall through to the FULL-body compute — reported size matches
    // what BODY[] would emit.
    const mailNoCache: Partial<MailType> = {
      ...base,
      rfc822_size: null,
    };
    const size = await buildFetchResponsePart(
      mailNoCache,
      { type: "RFC822.SIZE" },
      docId,
      mailbox
      // userId omitted intentionally — persist step is fire-and-forget
      // and skipped without a userId; the fetch response is independent
      // of the persist outcome.
    );
    const body = await buildFetchResponsePart(
      mailNoCache,
      { type: "BODY", peek: true, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(size!.type).toBe("simple");
    expect(body!.type === "stream" || body!.type === "literal").toBe(true);
    if (
      size!.type === "simple" &&
      (body!.type === "literal" || body!.type === "stream")
    ) {
      const reported = Number(size!.content.replace("RFC822.SIZE ", ""));
      expect(reported).toBe(body!.length);
    }
  });

  it("falls through to compute when rfc822_size is absent (field not projected)", async () => {
    // Symmetric with the null case but for callers whose SELECT didn't
    // include `rfc822_size` (e.g. a FETCH that only asked for FLAGS but
    // downstream code still routes through buildFetchResponsePart with a
    // partial mail). typeof undefined !== 'number' guards this branch.
    const mailNoField: Partial<MailType> = { ...base };
    delete (mailNoField as { rfc822_size?: number | null }).rfc822_size;
    const size = await buildFetchResponsePart(
      mailNoField,
      { type: "RFC822.SIZE" },
      docId,
      mailbox
    );
    expect(size!.type).toBe("simple");
    if (size!.type === "simple") {
      expect(size!.content.startsWith("RFC822.SIZE ")).toBe(true);
      const reported = Number(size!.content.replace("RFC822.SIZE ", ""));
      // Non-zero — the compute path actually ran.
      expect(reported).toBeGreaterThan(0);
    }
  });
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
    return contentAsString(part!);
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
    // Post-cache-deletion: MIME_PART bare/`.TEXT` returns a stream (via
    // `streamPartBodyFromSegments`); `.HEADER`/`.MIME` still returns a
    // literal (materialized MIME header block). Normalize both into a
    // stringy `content` + verified `length` so the assertions below
    // stay uniform.
    if (part!.type === "literal") {
      expect(Buffer.byteLength(part!.content, "utf8")).toBe(part!.length);
      return {
        header: part!.header,
        length: part!.length,
        content: contentAsString(part!),
      };
    }
    if (part!.type === "stream") {
      const chunks: Buffer[] = [];
      for await (const c of part!.stream) chunks.push(c);
      const buffered = Buffer.concat(chunks as unknown as Uint8Array[]);
      expect(buffered.byteLength).toBe(part!.length);
      return {
        header: part!.header,
        length: part!.length,
        content: buffered.toString("utf8"),
      };
    }
    throw new Error(`unexpected part type: ${part!.type}`);
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

// The cached FULL/TEXT/MIME_PART path must preserve three distinct
// response shapes: an empty body renders `BODY[TEXT] NIL` (not a 2-byte
// CRLF literal), and a nonexistent part drops the response part entirely
// (not a spurious `NIL` simple). A zero-length Buffer cannot distinguish
// them, so the cache carries a tri-state result instead.
describe("buildBodyResponsePart cached-path shape preservation", () => {
  it("BODY[TEXT] on a mail with no text/html/attachments emits `BODY[TEXT] NIL`", async () => {
    // No text, no html, no attachments — the source content is `""`, which
    // RFC 3501 renders as `BODY[TEXT] NIL`, not a 2-byte `\r\n` literal.
    const mail: Partial<MailType> = {
      messageId: "<empty@local>",
      text: "",
      html: "",
      attachments: [],
    };
    const part = await buildBodyResponsePart(
      mail,
      { type: "BODY", peek: false, section: { type: "TEXT" } },
      "doc-empty-text",
      "INBOX"
    );
    expect(part).toEqual({ type: "simple", content: "BODY[TEXT] NIL" });
  });

  it("BODY[99] on a message that has no such part is DROPPED (returns null)", async () => {
    // Nonexistent MIME part → `getBodyPart` returns `null` →
    // `getBodyContent` returns `null` → the whole response part is omitted
    // from the FETCH tuple (not emitted as a spurious `BODY[99] NIL`).
    const mail: Partial<MailType> = {
      messageId: "<nopart@local>",
      text: "some text",
      html: "<p>some html</p>",
      attachments: [],
    };
    const part = await buildBodyResponsePart(
      mail,
      {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "99" },
      },
      "doc-nopart",
      "INBOX"
    );
    expect(part).toBeNull();
  });

  it("BODY[2] on a text-only mail (no part 2) is DROPPED, not emitted as NIL", async () => {
    // Text-only mail → only part 1 exists. Asking for part 2 must drop the
    // response part entirely.
    const mail: Partial<MailType> = {
      messageId: "<textonly@local>",
      text: "only text here",
      html: "",
      attachments: [],
    };
    const part = await buildBodyResponsePart(
      mail,
      {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "2" },
      },
      "doc-textonly-part2",
      "INBOX"
    );
    expect(part).toBeNull();
  });
});

// Reviewoie R1 on #770 caught 3 HIGH bugs, all rooted in the same class:
// existing fixtures pre-populate `mail.text = "..."` (materialized), which
// forces the non-lazy code path. Prod mails on the FETCH hot path arrive
// with `text` undefined + `text_octets` set. The fall-through paths
// (`.MIME` / `.HEADER` sub-sections, partial TEXT, partial MIME_PART)
// all read `mail.text.trim()` directly — undefined → predicate false →
// wrong shape. Fixed by re-adding materialized `text` / `html` to
// `addBodyFields` for TEXT + MIME_PART. These tests EXPLICITLY use the
// prod-shape mail (lazy fields only, text/html undefined) to guard
// against the field-projection regressing again.
describe("buildBodyResponsePart on prod-shape (lazy-projected) mail (inbox #770 R1)", () => {
  const contentAsString = (part: FetchResponsePart): string => {
    if (part.type === "literal") {
      return Buffer.isBuffer(part.content)
        ? part.content.toString("utf8")
        : part.content;
    }
    if (part.type === "simple") return part.content;
    throw new Error(`unexpected type ${part.type}`);
  };

  // Prod-shape: mail row projected by getMailsByRange as it appears
  // for a real FETCH — no `text` / `html` strings, just octet counts +
  // synthetic id fields.
  const prodShapeMail = (
    overrides: Partial<MailType & { text_octets?: number; html_octets?: number; mail_id?: string; user_id?: string }> = {}
  ): Partial<MailType> => ({
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<prod-shape@local>",
    date: new Date("2026-08-01T00:00:00Z"),
    from: { text: "a@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "b@example.com", value: [] } as unknown as MailType["to"],
    subject: "prod shape",
    attachments: [] as unknown as MailType["attachments"],
    // text / html deliberately undefined
    text_octets: 100,
    html_octets: 100,
    mail_id: "mail-prod",
    user_id: "user-prod",
    ...overrides,
  }) as Partial<MailType>;

  // These 3 tests EXPLICITLY set `text: undefined` so they exercise the
  // failure mode reviewoie R1 caught: if `addBodyFields` were to drop
  // `text`/`html` from the projection again, `getMailsByRange` would
  // return this exact shape (lazy fields only), and the fall-through
  // paths (`.MIME`/`.HEADER` → `getBodyPartHeaders`, partial TEXT →
  // `buildFullMessage`, partial MIME_PART bare → `getBodyPart`) would
  // all fail. The specific failure mode differs per path:
  //   - `getBodyPartHeaders` / `getBodyPart`: predicates
  //     `mail.text && mail.text.trim().length > 0` short-circuit on
  //     undefined → hasText/hasHtml degrade to false → silent
  //     null-return (response part dropped from the FETCH tuple with
  //     no diagnostic).
  //   - `buildFullMessage`: throws
  //     "buildFullMessage: cannot materialize a lazy-text segment"
  //     when segments are lazy.
  // Under the CURRENT code these paths ALSO fail — that's the point:
  // a regression that reintroduced the projection defect wouldn't be
  // caught by these tests (they'd match the failing-shape from BOTH
  // directions). The load-bearing regression guard is the
  // `getRequestedFields` describe at :214-215 asserting `text`/`html`
  // ARE projected. These tests document the fall-through paths that
  // depend on that projection — a paired documentation of the
  // failure surface.
  it("BODY[1.MIME] on lazy-only mail (text/html undefined) — silent null-return via short-circuit", async () => {
    const mail = prodShapeMail({ text: undefined as unknown as string, html: undefined as unknown as string });
    // `getBodyPartHeaders`'s predicate is
    // `mail.text && mail.text.trim().length > 0` — undefined
    // short-circuits before `.trim()`, `hasText`/`hasHtml` degrade to
    // falsy, and the early `!hasAttachments && !hasText && !hasHtml
    // → return null` fires. Silent null-return (NOT a throw) — the
    // response part is dropped from the FETCH tuple with no
    // diagnostic. That's the class of wrong-shape bug the projection
    // guards against.
    const part = await buildBodyResponsePart(
      mail,
      {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "1", subSection: "MIME" },
      },
      "doc-prod-mime-lazy",
      "INBOX"
    );
    expect(part).toBeNull();
  });

  it("BODY[TEXT]<0.100> on lazy-only mail — buildFullMessage throws on lazy segments", async () => {
    const mail = prodShapeMail({ text: undefined as unknown as string, html: undefined as unknown as string });
    // getBodyContent → buildFullMessage throws
    // "buildFullMessage: cannot materialize a lazy-text segment" when
    // segments are lazy — same failure mode reviewoie R1 caught.
    // Under buildBodyResponsePart the throw is caught upstream and
    // logged as `Error processing message`; the tag itself completes
    // OK from the client's perspective but the response part is dropped.
    let threw = false;
    let result: FetchResponsePart | null = null;
    try {
      result = await buildBodyResponsePart(
        mail,
        {
          type: "BODY",
          peek: true,
          section: { type: "TEXT" },
          partial: { start: 0, length: 100 },
        },
        "doc-prod-partial-text-lazy",
        "INBOX"
      );
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("lazy-text segment");
    }
    // Documents the failure — throw or null-return, both bad shapes
    // for the client. Projection MUST populate `text`/`html` on
    // getMailsByRange output for this path to be safe.
    expect(threw || result === null).toBe(true);
  });

  it("BODY[1]<0.100> on lazy-only mail — getBodyPart returns null (drops the fetch item)", async () => {
    const mail = prodShapeMail({ text: undefined as unknown as string, html: undefined as unknown as string });
    // getBodyPart: `mail.text && mail.text.trim().length > 0` — undefined
    // short-circuits to false. hasHtml also false (same reason). No
    // part matches → returns null → response part dropped.
    const part = await buildBodyResponsePart(
      mail,
      {
        type: "BODY",
        peek: true,
        section: { type: "MIME_PART", partNumber: "1" },
        partial: { start: 0, length: 100 },
      },
      "doc-prod-partial-part-lazy",
      "INBOX"
    );
    expect(part).toBeNull();
  });
});

describe("buildFetchResponsePart partial BODY[]<start.length> streams through segments", () => {
  // iOS Mail's chunked large-body pull uses `BODY[]<0.65536>`, then
  // `BODY[]<65536.65536>`, etc. Under the segment-walk streamer, partial
  // fetches take the SAME shape as non-partial full fetches — they
  // project the LAZY synthetics (`text_octets` / `html_octets` +
  // `mail_id` / `user_id`) and stream through `streamPartialFromSegments`,
  // slicing in-flight to the requested [start, start+length) window.
  // Peak stays O(chunk) regardless of body size, which is the whole
  // point of #757's kill-materialized-fallback direction — cache is
  // not needed when the stream itself is byte-range-aware.

  const mail: Partial<MailType> = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<partial@local>",
    date: new Date("2026-07-31T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "partial",
    text: "plain body content",
    html: "<p>rich body content</p>",
    attachments: [] as unknown as MailType["attachments"],
  };

  it("returns a stream part for BODY[]<0.100>", async () => {
    const part = await buildFetchResponsePart(
      mail,
      {
        type: "BODY",
        peek: false,
        section: { type: "FULL" },
        partial: { start: 0, length: 100 },
      },
      "doc-partial",
      "INBOX"
    );
    expect(part).not.toBeNull();
    expect(part!.type).toBe("stream");
    // Header carries the origin-octet form (`<start>`), no length echo
    // per RFC 3501 §7.4.2 msg-att-static.
    if (part!.type === "stream") {
      expect(part!.header).toBe("BODY[]<0>");
      expect(part!.length).toBeLessThanOrEqual(100);
      expect(part!.length).toBeGreaterThan(0);
    }
  });

  it("emits EXACTLY `part.length` bytes on chunked <off.N> partial sequence (wire-trailer parity)", async () => {
    // Reviewoie #769 R1 caught: partial FULL was using `sumSegmentBytes`
    // (trailer-inclusive) as the total-bytes ceiling, but
    // `streamPartialFromSegments` never emits the trailer — so any
    // partial reaching end-of-body advertised `{N}` two bytes larger
    // than what actually landed on the wire. iOS's real chunked sync
    // uses `<0.65536>`, `<65536.65536>`, ..., `<last.65536>` — the last
    // chunk always hits this, corrupting every subsequent tagged
    // response. This test walks the same *pattern* at a much smaller
    // chunk (250 B) against a small in-memory mail, so at least three
    // iterations fire and the last one lands < chunkSize with the
    // clamp active. Drains each stream and cross-checks the count
    // instead of asserting only on `part.length` — the parity test in
    // session-utils compared against `streamFromSegments` (which also
    // excludes the trailer, so its parity held) and missed this class.
    const chunkSize = 250;
    let start = 0;
    for (let i = 0; i < 10; i += 1) {
      const part = await buildFetchResponsePart(
        mail,
        {
          type: "BODY",
          peek: false,
          section: { type: "FULL" },
          partial: { start, length: chunkSize },
        },
        `doc-partial-chunked-${i}`,
        "INBOX"
      );
      if (!part) break;
      if (part.type === "simple") break; // NIL at end
      expect(part.type).toBe("stream");
      if (part.type !== "stream") break;
      let emitted = 0;
      for await (const chunk of part.stream) emitted += chunk.byteLength;
      expect(
        emitted,
        `wire desync at chunk ${i} <${start}.${chunkSize}>: advertised ${part.length}, emitted ${emitted}`
      ).toBe(part.length);
      if (part.length < chunkSize) break; // reached end
      start += chunkSize;
    }
  });

  it("clamps length to available bytes when start+length exceeds total", async () => {
    // For this small mail, requesting 100_000_000 bytes at offset 0
    // must return a stream advertising the actual full body length,
    // not 100_000_000 (which would desync the {N} literal).
    const part = await buildFetchResponsePart(
      mail,
      {
        type: "BODY",
        peek: false,
        section: { type: "FULL" },
        partial: { start: 0, length: 100_000_000 },
      },
      "doc-partial-clamp",
      "INBOX"
    );
    expect(part!.type).toBe("stream");
    if (part!.type === "stream") {
      // Real body is a few hundred bytes; sanity-check the length was clamped.
      expect(part!.length).toBeLessThan(100_000_000);
      expect(part!.length).toBeGreaterThan(0);
    }
  });

  it("returns NIL when start is past end-of-body", async () => {
    const part = await buildFetchResponsePart(
      mail,
      {
        type: "BODY",
        peek: false,
        section: { type: "FULL" },
        partial: { start: 100_000_000, length: 100 },
      },
      "doc-partial-past-end",
      "INBOX"
    );
    expect(part!.type).toBe("simple");
    if (part!.type === "simple") {
      expect(part!.content).toContain("NIL");
    }
  });

  it("addBodyFields for BODY[FULL] with partial projects the same LAZY synthetics as non-partial", () => {
    const partialFields = new Set<FetchRequestedField>();
    addBodyFields(
      {
        type: "BODY",
        peek: false,
        section: { type: "FULL" },
        partial: { start: 0, length: 100 },
      },
      partialFields
    );
    const fullFields = new Set<FetchRequestedField>();
    addBodyFields(
      { type: "BODY", peek: false, section: { type: "FULL" } },
      fullFields
    );
    // Both variants project the lazy synthetics — the field set is
    // identical because both take the segment-walk streaming path.
    for (const f of ["text_octets", "html_octets", "mail_id", "user_id"] as const) {
      expect(partialFields.has(f as FetchRequestedField)).toBe(true);
      expect(fullFields.has(f as FetchRequestedField)).toBe(true);
    }
    for (const f of ["text", "html"] as const) {
      expect(partialFields.has(f as FetchRequestedField)).toBe(false);
      expect(fullFields.has(f as FetchRequestedField)).toBe(false);
    }
  });
});
