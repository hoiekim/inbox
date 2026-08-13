/**
 * Tests for session-utils.ts — pure utility functions extracted from ImapSession
 * Covers inbox #341
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import {
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachment
} from "../mails/util";

// Mock the "server" module before importing session-utils. `mock.module` is
// process-global in Bun and reaches the leaf module the barrel re-exports, so
// the attachment helpers are forwarded VERBATIM rather than redirected at a temp
// dir — redirecting them broke mails/util.test.ts's constant assertions in the
// same run.
mock.module("server", () => ({
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachment,
  logger: {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {})
  }
}));

// Attachment bodies are measured (stat) and read from the same path, so these
// tests write real files rather than stubbing a reader — a stub would let the
// measured size and the emitted bytes disagree, which is exactly the bug class
// this module has to make impossible.
const TEST_ID_PREFIX = "session-utils-test-";
const attachmentPath = (id: string) => getAttachmentFilePath(TEST_ID_PREFIX + id);
const writtenIds = new Set<string>();
const writeAttachment = (id: string, data: Buffer): Buffer => {
  fs.mkdirSync(ATTACHMENT_FOLDER, { recursive: true });
  fs.writeFileSync(attachmentPath(id), data);
  writtenIds.add(id);
  return data;
};

afterAll(() => {
  for (const id of writtenIds) fs.rmSync(attachmentPath(id), { force: true });
});

import {
  applyPartialFetch,
  getBodySectionKey,
  shouldMarkAsRead,
  buildFullMessage,
  buildMessageSegments,
  streamFromSegments,
  getBodyPart,
  getBodyPartHeaders,
  _emitBase64ForTests
} from "./session-utils";
import type {
  BodySection,
  FetchDataItem,
  PartialRange
} from "./types";
import type { MailType } from "common";

// ---------------------------------------------------------------------------
// applyPartialFetch
// ---------------------------------------------------------------------------

describe("applyPartialFetch", () => {
  it("returns empty string when start is beyond content length", () => {
    const content = "Hello";
    const partial: PartialRange = { start: 100, length: 5 };
    expect(applyPartialFetch(content, partial)).toBe("");
  });

  it("returns empty string when start equals content length", () => {
    const content = "Hello";
    const partial: PartialRange = { start: 5, length: 5 };
    expect(applyPartialFetch(content, partial)).toBe("");
  });

  it("slices a portion from the middle of content", () => {
    const content = "Hello, World!";
    const partial: PartialRange = { start: 7, length: 5 };
    expect(applyPartialFetch(content, partial)).toBe("World");
  });

  it("slices from start", () => {
    const content = "Hello, World!";
    const partial: PartialRange = { start: 0, length: 5 };
    expect(applyPartialFetch(content, partial)).toBe("Hello");
  });

  it("clamps to end of content when length exceeds remaining bytes", () => {
    const content = "Hello";
    const partial: PartialRange = { start: 3, length: 100 };
    expect(applyPartialFetch(content, partial)).toBe("lo");
  });

  it("handles exact end slice", () => {
    const content = "Hello";
    const partial: PartialRange = { start: 3, length: 2 };
    expect(applyPartialFetch(content, partial)).toBe("lo");
  });

  it("handles multi-byte unicode (byte offsets, not char offsets)", () => {
    // "日" is 3 bytes in UTF-8
    const content = "日本語";
    const buf = Buffer.from(content, "utf8");
    // Each character is 3 bytes, so skip first character (3 bytes)
    const partial: PartialRange = { start: 3, length: 3 };
    const result = applyPartialFetch(content, partial);
    expect(result).toBe("本");
    // Verify the buffer length
    expect(buf.length).toBe(9);
  });

  it("returns empty string for zero-length content", () => {
    const partial: PartialRange = { start: 0, length: 5 };
    expect(applyPartialFetch("", partial)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getBodySectionKey
// ---------------------------------------------------------------------------

describe("getBodySectionKey", () => {
  it("returns BODY[] for FULL section", () => {
    const section: BodySection = { type: "FULL" };
    expect(getBodySectionKey(section)).toBe("BODY[]");
  });

  it("returns BODY[TEXT] for TEXT section", () => {
    const section: BodySection = { type: "TEXT" };
    expect(getBodySectionKey(section)).toBe("BODY[TEXT]");
  });

  it("returns BODY[HEADER] for HEADER section", () => {
    const section: BodySection = { type: "HEADER" };
    expect(getBodySectionKey(section)).toBe("BODY[HEADER]");
  });

  it("returns BODY[partNumber] for MIME_PART section", () => {
    const section: BodySection = { type: "MIME_PART", partNumber: "1" };
    expect(getBodySectionKey(section)).toBe("BODY[1]");
  });

  it("returns BODY[nested partNumber] for nested MIME_PART section", () => {
    const section: BodySection = { type: "MIME_PART", partNumber: "1.2.3" };
    expect(getBodySectionKey(section)).toBe("BODY[1.2.3]");
  });

  // #657: the sub-section must survive in the response label, otherwise a
  // client sees the reply keyed as BODY[1] for its BODY[1.HEADER] request.
  it("returns BODY[1.HEADER] for MIME_PART with HEADER sub-section", () => {
    const section: BodySection = {
      type: "MIME_PART",
      partNumber: "1",
      subSection: "HEADER"
    };
    expect(getBodySectionKey(section)).toBe("BODY[1.HEADER]");
  });

  it("returns BODY[2.MIME] for MIME_PART with MIME sub-section", () => {
    const section: BodySection = {
      type: "MIME_PART",
      partNumber: "2",
      subSection: "MIME"
    };
    expect(getBodySectionKey(section)).toBe("BODY[2.MIME]");
  });

  it("returns BODY[1.2.TEXT] for nested MIME_PART with TEXT sub-section", () => {
    const section: BodySection = {
      type: "MIME_PART",
      partNumber: "1.2",
      subSection: "TEXT"
    };
    expect(getBodySectionKey(section)).toBe("BODY[1.2.TEXT]");
  });

  it("returns BODY[HEADER.FIELDS (...)] for HEADER_FIELDS section without not", () => {
    const section: BodySection = {
      type: "HEADER_FIELDS",
      fields: ["From", "To", "Subject"]
    };
    expect(getBodySectionKey(section)).toBe("BODY[HEADER.FIELDS (From To Subject)]");
  });

  it("returns BODY[HEADER.FIELDS.NOT (...)] for HEADER_FIELDS section with not=true", () => {
    const section: BodySection = {
      type: "HEADER_FIELDS",
      not: true,
      fields: ["Received", "X-Mailer"]
    };
    expect(getBodySectionKey(section)).toBe("BODY[HEADER.FIELDS.NOT (Received X-Mailer)]");
  });

  it("returns BODY[HEADER.FIELDS (...)] for HEADER_FIELDS section with not=false", () => {
    const section: BodySection = {
      type: "HEADER_FIELDS",
      not: false,
      fields: ["Date"]
    };
    expect(getBodySectionKey(section)).toBe("BODY[HEADER.FIELDS (Date)]");
  });

  it("returns BODY[HEADER.FIELDS (...)] for HEADER_FIELDS with single field", () => {
    const section: BodySection = {
      type: "HEADER_FIELDS",
      fields: ["Subject"]
    };
    expect(getBodySectionKey(section)).toBe("BODY[HEADER.FIELDS (Subject)]");
  });
});

// ---------------------------------------------------------------------------
// shouldMarkAsRead
// ---------------------------------------------------------------------------

describe("shouldMarkAsRead", () => {
  it("returns false for empty data items array", () => {
    expect(shouldMarkAsRead([])).toBe(false);
  });

  it("returns false for non-BODY items only", () => {
    const items: FetchDataItem[] = [
      { type: "ENVELOPE" },
      { type: "FLAGS" },
      { type: "UID" }
    ];
    expect(shouldMarkAsRead(items)).toBe(false);
  });

  it("returns false for the bare BODY structure item (non-destructive, #666)", () => {
    // A structure fetch (BODYSTRUCTURE, incl. the non-extensible bare `BODY`)
    // never sets \Seen — only BODY[...] content without .PEEK does.
    const items: FetchDataItem[] = [{ type: "BODYSTRUCTURE", extensible: false }];
    expect(shouldMarkAsRead(items)).toBe(false);
  });

  it("returns false when BODY item has peek=true", () => {
    const items: FetchDataItem[] = [
      {
        type: "BODY",
        peek: true,
        section: { type: "FULL" }
      }
    ];
    expect(shouldMarkAsRead(items)).toBe(false);
  });

  it("returns true when BODY item has peek=false", () => {
    const items: FetchDataItem[] = [
      {
        type: "BODY",
        peek: false,
        section: { type: "FULL" }
      }
    ];
    expect(shouldMarkAsRead(items)).toBe(true);
  });

  it("returns true when mixed items include BODY with peek=false", () => {
    const items: FetchDataItem[] = [
      { type: "ENVELOPE" },
      { type: "FLAGS" },
      {
        type: "BODY",
        peek: false,
        section: { type: "TEXT" }
      }
    ];
    expect(shouldMarkAsRead(items)).toBe(true);
  });

  it("returns false when only BODY.PEEK items exist", () => {
    const items: FetchDataItem[] = [
      {
        type: "BODY",
        peek: true,
        section: { type: "HEADER" }
      },
      {
        type: "BODY",
        peek: true,
        section: { type: "TEXT" }
      }
    ];
    expect(shouldMarkAsRead(items)).toBe(false);
  });

  it("returns true when at least one BODY (non-peek) among multiple items", () => {
    const items: FetchDataItem[] = [
      {
        type: "BODY",
        peek: true,
        section: { type: "HEADER" }
      },
      {
        type: "BODY",
        peek: false,
        section: { type: "TEXT" }
      }
    ];
    expect(shouldMarkAsRead(items)).toBe(true);
  });

  it("returns true for RFC822 (non-peek, equivalent to BODY[])", () => {
    expect(shouldMarkAsRead([{ type: "RFC822" }])).toBe(true);
  });

  it("returns true for RFC822.TEXT (non-peek, equivalent to BODY[TEXT])", () => {
    expect(shouldMarkAsRead([{ type: "RFC822.TEXT" }])).toBe(true);
  });

  it("returns false for RFC822.HEADER (peek-equivalent to BODY.PEEK[HEADER])", () => {
    expect(shouldMarkAsRead([{ type: "RFC822.HEADER" }])).toBe(false);
  });

  it("returns false for RFC822.SIZE (no body content fetched)", () => {
    expect(shouldMarkAsRead([{ type: "RFC822.SIZE" }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildFullMessage
// ---------------------------------------------------------------------------

describe("buildFullMessage", () => {
  it("returns headers + empty body for mail with no content", () => {
    const mail: Partial<MailType> = {};
    const result = buildFullMessage(mail);
    expect(result).toContain("MIME-Version: 1.0");
    expect(result).toEndWith("\r\n\r\n");
  });

  it("returns headers + encoded text for plain-text-only mail", () => {
    const mail: Partial<MailType> = { text: "Hello, World!" };
    const result = buildFullMessage(mail);
    expect(result).toContain("MIME-Version: 1.0");
    expect(result).toContain("text/plain");
    // Body should be base64-encoded text
    const b64Hello = Buffer.from("Hello, World!", "utf8").toString("base64");
    expect(result).toContain(b64Hello);
  });

  it("returns headers + encoded html for html-only mail", () => {
    const mail: Partial<MailType> = { html: "<p>Hello</p>" };
    const result = buildFullMessage(mail);
    expect(result).toContain("MIME-Version: 1.0");
    expect(result).toContain("text/html");
    const b64Html = Buffer.from("<p>Hello</p>", "utf8").toString("base64");
    expect(result).toContain(b64Html);
  });

  it("returns multipart/alternative for text+html mail", () => {
    const mail: Partial<MailType> = {
      text: "Hello plain",
      html: "<p>Hello HTML</p>"
    };
    const result = buildFullMessage(mail, "test-doc-123");
    expect(result).toContain("multipart/alternative");
    expect(result).toContain("boundary_test-doc-123");
    expect(result).toContain("Content-Type: text/plain; charset=utf-8");
    expect(result).toContain("Content-Type: text/html; charset=utf-8");
    expect(result).toContain("Content-Transfer-Encoding: base64");
    // Should contain both encoded parts
    const b64Text = Buffer.from("Hello plain", "utf8").toString("base64");
    const b64Html = Buffer.from("<p>Hello HTML</p>", "utf8").toString("base64");
    expect(result).toContain(b64Text);
    expect(result).toContain(b64Html);
    // Should end with closing boundary
    expect(result).toContain("--boundary_test-doc-123--");
  });

  it("returns multipart/mixed for text+html+attachment mail", () => {
    const fakeAttachmentData = writeAttachment(
      "att-file-id-1",
      Buffer.from("PDF_BINARY_DATA")
    );

    const mail: Partial<MailType> = {
      text: "See attached",
      html: "<p>See attached</p>",
      attachments: [
        {
          content: { data: TEST_ID_PREFIX + "att-file-id-1" },
          contentType: "application/pdf",
          filename: "document.pdf",
          size: fakeAttachmentData.byteLength
        }
      ]
    };
    const result = buildFullMessage(mail, "doc-mixed-1");
    expect(result).toContain("multipart/mixed");
    expect(result).toContain("Content-Type: application/pdf");
    expect(result).toContain('filename="document.pdf"');
    expect(result).toContain("Content-Disposition: attachment");
    expect(result).toContain(fakeAttachmentData.toString("base64"));
    expect(result).toContain("--boundary_doc-mixed-1--");
  });

  it("returns multipart/mixed for text-only+attachment mail", () => {
    const fakeData = writeAttachment("att-file-id-2", Buffer.from("SOME_DATA"));

    const mail: Partial<MailType> = {
      text: "See attached",
      attachments: [
        {
          content: { data: TEST_ID_PREFIX + "att-file-id-2" },
          contentType: "text/plain",
          filename: "notes.txt",
          size: fakeData.byteLength
        }
      ]
    };
    const result = buildFullMessage(mail, "doc-mixed-2");
    expect(result).toContain("multipart/mixed");
    expect(result).toContain("Content-Type: text/plain");
    expect(result).toContain('filename="notes.txt"');
    expect(result).toContain(fakeData.toString("base64"));
  });

  it("uses messageId fallback when docId is missing for multipart boundary", () => {
    const mail: Partial<MailType> = {
      text: "Hello",
      html: "<p>Hello</p>",
      messageId: "<test-msg-id@example.com>"
    };
    // No docId provided
    const result = buildFullMessage(mail);
    // Should still produce multipart/alternative with a boundary derived from messageId
    expect(result).toContain("multipart/alternative");
    expect(result).toContain("multipart/alternative");
  });

  it("uses CRLF line endings throughout", () => {
    const mail: Partial<MailType> = { text: "Hello" };
    const result = buildFullMessage(mail);
    // Split by \r\n — if no bare \n, this works cleanly
    const lines = result.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
  });

  // #826: the MIME framing this function emits is derived from stored values
  // an external sender controls, so a hostile mail must not be able to steer
  // it.
  describe("stored values cannot steer the MIME framing (#826)", () => {
    it("a subject carrying boundary=\"…\" does not become the boundary", () => {
      // The boundary used to be recovered by matching `boundary="([^"]+)"`
      // against the whole header block, and Subject is emitted ahead of
      // Content-Type — so this subject won the match and the `--` delimiters
      // stopped agreeing with the declared boundary.
      const result = buildFullMessage(
        {
          subject: 'winter sale boundary="hijacked"',
          text: "Hello",
          html: "<p>Hello</p>"
        },
        "doc-hijack"
      );

      expect(result).toContain(
        'Content-Type: multipart/alternative; boundary="boundary_doc-hijack"'
      );
      expect(result).toContain("--boundary_doc-hijack\r\n");
      expect(result).toContain("--boundary_doc-hijack--");
      expect(result).not.toContain("--hijacked");
    });

    it("a subject carrying the text `Content-Type: ` is not rewritten", () => {
      // `rewriteContentType`'s match used to be unanchored, and Subject is
      // emitted ahead of Content-Type — so this subject won the replace and
      // the user's real subject was overwritten on BODY[] / RFC822 while
      // BODY[HEADER] (which goes through formatHeaders directly) still showed
      // the true one. No CRLF required.
      const result = buildFullMessage(
        {
          subject: 'Content-Type: text/plain; boundary="evil"',
          text: "Hello",
          html: "<p>Hello</p>"
        },
        "docA"
      );

      expect(result).toContain(
        'Subject: Content-Type: text/plain; boundary="evil"\r\n'
      );
      expect(result).toContain(
        'Content-Type: multipart/alternative; boundary="boundary_docA"\r\n'
      );
      expect(result).not.toContain("--evil");
    });

    it("an attachment with no contentType / filename still serializes", () => {
      // `attachments` comes off the JSONB column with no model hydration, so
      // a row written before a field existed arrives `undefined`. Sanitizing
      // it directly would throw on `.replace` and fail the whole FETCH.
      const data = writeAttachment("att-bare", Buffer.from("DATA"));
      const bare = {
        content: { data: TEST_ID_PREFIX + "att-bare" },
        size: data.byteLength
      } as unknown as MailType["attachments"][number];

      const result = buildFullMessage(
        { text: "hi", attachments: [bare] },
        "docC"
      );

      // Defaults match formatBodyStructure's for the same part, so a client
      // comparing BODYSTRUCTURE against the part headers sees one answer.
      expect(result).toContain("Content-Type: application/octet-stream\r\n");
      expect(result).toContain('filename="unnamed"\r\n');
      expect(result).not.toContain("undefined");
    });

    it("an attachment filename cannot open a new parameter or header", () => {
      const data = writeAttachment("att-inject", Buffer.from("DATA"));
      const result = buildFullMessage(
        {
          text: "See attached",
          attachments: [
            {
              content: { data: TEST_ID_PREFIX + "att-inject" },
              contentType: "text/plain\r\nX-Evil: 1",
              filename: 'safe.txt"; filename="payroll.pdf',
              size: data.byteLength
            }
          ]
        },
        "doc-att-inject"
      );

      expect(result).toContain("Content-Type: text/plain X-Evil: 1\r\n");
      expect(result).toContain(
        'Content-Disposition: attachment; filename="safe.txt\\"; filename=\\"payroll.pdf"\r\n'
      );
      expect(result.split("\r\n").some((l) => l.startsWith("X-Evil:"))).toBe(
        false
      );
    });
  });
});

// ---------------------------------------------------------------------------
// getBodyPart
// ---------------------------------------------------------------------------

describe("getBodyPart", () => {
  it("returns null for empty mail", () => {
    expect(getBodyPart({}, "1")).toBeNull();
  });

  it("returns base64-encoded text for single-text mail, part 1", () => {
    const mail: Partial<MailType> = { text: "Hello plain" };
    const result = getBodyPart(mail, "1");
    expect(result).toBe(Buffer.from("Hello plain", "utf8").toString("base64"));
  });

  it("returns null for single-text mail requesting part 2", () => {
    const mail: Partial<MailType> = { text: "Hello plain" };
    expect(getBodyPart(mail, "2")).toBeNull();
  });

  it("returns base64-encoded html for html-only mail, part 1", () => {
    const mail: Partial<MailType> = { html: "<p>Hello</p>" };
    const result = getBodyPart(mail, "1");
    expect(result).toBe(Buffer.from("<p>Hello</p>", "utf8").toString("base64"));
  });

  it("returns text for part 1 in text+html multipart/alternative mail", () => {
    const mail: Partial<MailType> = {
      text: "Plain text",
      html: "<p>HTML</p>"
    };
    const result = getBodyPart(mail, "1");
    expect(result).toBe(Buffer.from("Plain text", "utf8").toString("base64"));
  });

  it("returns html for part 2 in text+html multipart/alternative mail", () => {
    const mail: Partial<MailType> = {
      text: "Plain text",
      html: "<p>HTML</p>"
    };
    const result = getBodyPart(mail, "2");
    expect(result).toBe(Buffer.from("<p>HTML</p>", "utf8").toString("base64"));
  });

  it("returns null for out-of-range part in text+html mail", () => {
    const mail: Partial<MailType> = {
      text: "Plain text",
      html: "<p>HTML</p>"
    };
    expect(getBodyPart(mail, "3")).toBeNull();
  });

  it("returns text for part 1.1 in text+html+attachment multipart mail", () => {
    const mail: Partial<MailType> = {
      text: "Body text",
      html: "<p>Body HTML</p>",
      attachments: [
        {
          content: { data: "att-1" },
          contentType: "application/pdf",
          filename: "doc.pdf",
          size: 100
        }
      ]
    };
    const result = getBodyPart(mail, "1.1");
    expect(result).toBe(Buffer.from("Body text", "utf8").toString("base64"));
  });

  it("returns html for part 1.2 in text+html+attachment multipart mail", () => {
    const mail: Partial<MailType> = {
      text: "Body text",
      html: "<p>Body HTML</p>",
      attachments: [
        {
          content: { data: "att-1" },
          contentType: "application/pdf",
          filename: "doc.pdf",
          size: 100
        }
      ]
    };
    const result = getBodyPart(mail, "1.2");
    expect(result).toBe(Buffer.from("<p>Body HTML</p>", "utf8").toString("base64"));
  });

  it("returns attachment data for part 2 in mail with attachment", () => {
    const attData = writeAttachment("att-file-xyz", Buffer.from("ATTACHMENT_BYTES"));

    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: TEST_ID_PREFIX + "att-file-xyz" },
          contentType: "image/png",
          filename: "photo.png",
          size: 200
        }
      ]
    };
    const result = getBodyPart(mail, "2");
    expect(result).toBe(attData.toString("base64"));
  });

  it("returns null for an attachment whose file is missing", () => {

    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: TEST_ID_PREFIX + "missing-file" },
          contentType: "image/png",
          filename: "photo.png",
          size: 200
        }
      ]
    };
    const result = getBodyPart(mail, "2");
    expect(result).toBeNull();
  });

  it("returns null for out-of-range attachment index", () => {
    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: "att-1" },
          contentType: "text/plain",
          filename: "file.txt",
          size: 10
        }
      ]
    };
    // Part 3 would be attachment index 1 (0-based) but only 1 attachment exists
    expect(getBodyPart(mail, "3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getBodyPartHeaders (#657)
// ---------------------------------------------------------------------------

describe("getBodyPartHeaders", () => {
  const TEXT_HDR =
    "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64";
  const HTML_HDR =
    "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64";

  it("returns null for empty mail", () => {
    expect(getBodyPartHeaders({}, "1")).toBeNull();
  });

  it("returns text/plain headers for single-text mail, part 1", () => {
    expect(getBodyPartHeaders({ text: "Hello" }, "1")).toBe(TEXT_HDR);
  });

  it("returns text/html headers for html-only mail, part 1", () => {
    expect(getBodyPartHeaders({ html: "<p>Hi</p>" }, "1")).toBe(HTML_HDR);
  });

  it("returns per-part headers for text+html multipart/alternative", () => {
    const mail: Partial<MailType> = { text: "Plain", html: "<p>H</p>" };
    expect(getBodyPartHeaders(mail, "1")).toBe(TEXT_HDR);
    expect(getBodyPartHeaders(mail, "2")).toBe(HTML_HDR);
    expect(getBodyPartHeaders(mail, "3")).toBeNull();
  });

  it("returns nested-part headers for text+html+attachment multipart/mixed", () => {
    const mail: Partial<MailType> = {
      text: "Body",
      html: "<p>Body</p>",
      attachments: [
        {
          content: { data: "att-1" },
          contentType: "application/pdf",
          filename: "doc.pdf",
          size: 100
        }
      ]
    };
    expect(getBodyPartHeaders(mail, "1.1")).toBe(TEXT_HDR);
    expect(getBodyPartHeaders(mail, "1.2")).toBe(HTML_HDR);
  });

  it("returns attachment MIME headers with Content-Disposition for part 2", () => {
    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: "att-file" },
          contentType: "image/png",
          filename: "photo.png",
          size: 200
        }
      ]
    };
    expect(getBodyPartHeaders(mail, "2")).toBe(
      'Content-Type: image/png\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        'Content-Disposition: attachment; filename="photo.png"'
    );
  });

  it("escapes a hostile attachment contentType / filename (#826)", () => {
    // Same part headers as the segment builder emits, so both surfaces have
    // to survive the same stored bytes.
    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: "att-file" },
          contentType: "image/png\r\nX-Evil: 1",
          filename: 'photo.png"; filename="payroll.pdf',
          size: 200
        }
      ]
    };
    expect(getBodyPartHeaders(mail, "2")).toBe(
      "Content-Type: image/png X-Evil: 1\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        'Content-Disposition: attachment; filename="photo.png\\"; filename=\\"payroll.pdf"'
    );
  });

  it("defaults a missing contentType / filename instead of throwing", () => {
    const bare = {
      content: { data: "att-bare" },
      size: 10
    } as unknown as MailType["attachments"][number];
    expect(getBodyPartHeaders({ text: "Body", attachments: [bare] }, "2")).toBe(
      "Content-Type: application/octet-stream\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        'Content-Disposition: attachment; filename="unnamed"'
    );
  });

  it("returns null for out-of-range attachment index", () => {
    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: "att-1" },
          contentType: "text/plain",
          filename: "file.txt",
          size: 10
        }
      ]
    };
    expect(getBodyPartHeaders(mail, "3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// streamFromSegments — emitBase64 input chunking. Peak transient must stay
// O(SLICE_RAW_BYTES) (no full-source Buffer materialization) AND the emitted
// bytes must round-trip to the source exactly, including at UTF-16 surrogate
// pair boundaries and at non-multiple-of-3 slice boundaries.
// ---------------------------------------------------------------------------

describe("streamFromSegments — emitBase64 input chunking", () => {
  const SLICE_RAW_BYTES = 48 * 1024; // must match the constant in session-utils.ts

  const drainToBuffer = async (
    stream: AsyncIterable<Buffer>
  ): Promise<{ concatenated: Buffer; maxChunkBytes: number; chunkCount: number }> => {
    const chunks: Buffer[] = [];
    let maxChunkBytes = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.byteLength > maxChunkBytes) maxChunkBytes = chunk.byteLength;
    }
    return {
      concatenated: Buffer.concat(chunks),
      maxChunkBytes,
      chunkCount: chunks.length,
    };
  };

  it("produces byte-identical output to base64(source) for a small text mail", async () => {
    const mail: Partial<MailType> = { text: "Hello, streaming world!" };
    const segments = buildMessageSegments(mail, "small-text");
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    const expectedBody = Buffer.from(mail.text!, "utf8").toString("base64");
    expect(concatenated.toString("utf8")).toContain(expectedBody);
  });

  it("yields multiple chunks and never emits > ~64 KiB per chunk for a 200 KiB HTML body (input isn't materialized whole)", async () => {
    // 200 KiB of ASCII HTML — larger than SLICE_RAW_BYTES (48 KiB), so if the
    // pre-fix `Buffer.from(source, "utf8")` regressed back in, we'd see either
    // one giant chunk or peak transient tracking the source size. The
    // post-fix contract is: each yielded chunk stays in the ~64 KiB ballpark
    // (SLICE_RAW_BYTES raw → base64 expansion ≈ 4/3 → ~64 KiB out).
    const html = "<p>" + "x".repeat(200 * 1024 - 8) + "</p>";
    const mail: Partial<MailType> = { html };
    const segments = buildMessageSegments(mail, "big-html");
    const { concatenated, maxChunkBytes, chunkCount } = await drainToBuffer(
      streamFromSegments(segments)
    );

    // Chunk count must scale with body size — one giant chunk (the pre-fix
    // shape) would be `chunkCount === headers-count + 1 attachment-part`.
    expect(chunkCount).toBeGreaterThanOrEqual(4);
    // No single chunk should be anywhere near the source size.
    expect(maxChunkBytes).toBeLessThan(80 * 1024);
    // Reassembled body must round-trip back to the original HTML.
    const wire = concatenated.toString("utf8");
    const bodyMatch = wire.match(/base64\r\n\r\n([\s\S]*?)\r\n$/);
    expect(bodyMatch).not.toBeNull();
    const decoded = Buffer.from(bodyMatch![1], "base64").toString("utf8");
    expect(decoded).toBe(html);
  });

  it("handles a body whose UTF-8 length is NOT a multiple of 3 across many slices without corrupting the round-trip", async () => {
    // Pick a length that will straddle SLICE_RAW_BYTES boundaries and land on
    // various byte-count residuals — the carry logic between slices is what
    // could corrupt the base64 if buggy.
    // 100003 = 100 KiB + 3 bytes, distributed across multiple SLICE_RAW_BYTES
    // slices, ending with `len % 3 == 1` (100003 / 3 = 33334 remainder 1).
    const text = "a".repeat(100003);
    const mail: Partial<MailType> = { text };
    const segments = buildMessageSegments(mail, "misaligned");
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    const wire = concatenated.toString("utf8");
    const bodyMatch = wire.match(/base64\r\n\r\n([\s\S]*?)\r\n$/);
    expect(bodyMatch).not.toBeNull();
    // Round-trip must recover the exact original bytes.
    const decoded = Buffer.from(bodyMatch![1], "base64").toString("utf8");
    expect(decoded).toBe(text);
  });

  it("handles multi-byte UTF-8 (emoji) across slice boundaries", async () => {
    const emoji = "🚀".repeat(20000); // 80 000 UTF-8 bytes = 40 000 UTF-16 units
    const mail: Partial<MailType> = { text: emoji };
    const segments = buildMessageSegments(mail, "emoji");
    const { concatenated, maxChunkBytes } = await drainToBuffer(
      streamFromSegments(segments)
    );
    expect(maxChunkBytes).toBeLessThan(80 * 1024);
    const wire = concatenated.toString("utf8");
    const bodyMatch = wire.match(/base64\r\n\r\n([\s\S]*?)\r\n$/);
    expect(bodyMatch).not.toBeNull();
    const decoded = Buffer.from(bodyMatch![1], "base64").toString("utf8");
    expect(decoded).toBe(emoji);
  });

  it("keeps a surrogate pair whole when it straddles a chunk boundary — no U+FFFD injection", async () => {
    // CHUNK_CODE_UNITS = SLICE_RAW_BYTES / 3 = 49152 / 3 = 16384 code units.
    // Place a surrogate pair EXACTLY at positions 16383 (high) + 16384 (low)
    // so a naive `source.slice(0, 16384)` would split it. Each half would
    // encode to U+FFFD (3 UTF-8 bytes) instead of the pair's 4 bytes,
    // overshooting the pre-measured {N} by 2 bytes and desyncing the wire.
    const filler = "a".repeat(16383);
    const tail = "b".repeat(100);
    const text = filler + "🚀" + tail;
    const mail: Partial<MailType> = { text };
    const segments = buildMessageSegments(mail, "surrogate-split");

    // 1. Stream output must round-trip byte-for-byte, including the emoji.
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    const wire = concatenated.toString("utf8");
    const bodyMatch = wire.match(/base64\r\n\r\n([\s\S]*?)\r\n$/);
    expect(bodyMatch).not.toBeNull();
    const decoded = Buffer.from(bodyMatch![1], "base64").toString("utf8");
    expect(decoded).toBe(text);
    // Zero U+FFFD replacement characters in the decoded body.
    expect(decoded.indexOf("�")).toBe(-1);

    // 2. Emitted body byte-length must equal the pre-measured length —
    // otherwise {N} desyncs and corrupts the IMAP connection.
    const emittedBodyBytes = Buffer.byteLength(bodyMatch![1], "utf8");
    const rawBytes = Buffer.byteLength(text, "utf8");
    const expectedBodyBytes = Math.ceil(rawBytes / 3) * 4;
    expect(emittedBodyBytes).toBe(expectedBodyBytes);
  });

  it("empty body yields no base64 output (short-circuit path)", async () => {
    const mail: Partial<MailType> = { text: "" };
    const segments = buildMessageSegments(mail, "empty-text");
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    const wire = concatenated.toString("utf8");
    // Headers-only, no body segment output between headers and terminating CRLF.
    expect(wire).toContain("MIME-Version: 1.0");
    expect(wire).not.toMatch(/base64\r\n\r\n[A-Za-z0-9+/=]+/);
  });

  // ---------------------------------------------------------------------------
  // emitBase64 chunked-source parity. Feeding the same source as one whole
  // string vs. as an async iterable of N pieces must produce byte-identical
  // output — the pg SUBSTRING streaming path relies on this. Any split at a
  // surrogate pair, at a multi-byte UTF-8 continuation, or at a random code-
  // unit boundary must round-trip correctly.
  // ---------------------------------------------------------------------------

  const drainStrChunks = async (
    stream: AsyncIterable<Buffer>
  ): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  };

  const asyncOf = (items: string[]): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  });

  const splitIntoNChunks = (s: string, n: number): string[] => {
    const chunks: string[] = [];
    const size = Math.ceil(s.length / n);
    for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
    return chunks;
  };

  it("split-input parity: whole-string, 2-chunk, 10-chunk, 1000-chunk all match", async () => {
    // ASCII case first — a clean cross-boundary test with no UTF-8 hazards,
    // so any divergence is purely the chunking algorithm's fault.
    const src = "a".repeat(100_000) + "-END-";
    const whole = (await drainStrChunks(_emitBase64ForTests(src))).toString("utf8");
    for (const n of [1, 2, 3, 10, 100, 1000]) {
      const chunks = splitIntoNChunks(src, n);
      const out = (
        await drainStrChunks(_emitBase64ForTests(asyncOf(chunks)))
      ).toString("utf8");
      expect(out).toBe(whole);
    }
  });

  it("split-input parity holds when a multi-byte UTF-8 sequence straddles a chunk boundary", async () => {
    // "🚀" is a UTF-16 surrogate pair (2 code units → 4 UTF-8 bytes). Split
    // the source such that the emoji lands at position 5000, then chunk it
    // in ways that put the surrogate pair boundary at various places:
    //   [len 5000 (before pair), len rest (from pair start)]
    //   [len 5001 (mid-pair), len rest (from low surrogate)]
    const src = "a".repeat(5000) + "🚀" + "b".repeat(5000);
    const whole = (await drainStrChunks(_emitBase64ForTests(src))).toString("utf8");

    // Split BEFORE the pair — clean chunk boundary.
    const before = [src.slice(0, 5000), src.slice(5000)];
    expect((await drainStrChunks(_emitBase64ForTests(asyncOf(before)))).toString("utf8"))
      .toBe(whole);

    // Split MID pair — chunk1 ends with the high surrogate, chunk2 starts
    // with the low. Naive encode would drop each half to U+FFFD (3 bytes
    // each) instead of the pair's 4 bytes. The char-carry across chunks
    // keeps the pair whole.
    const mid = [src.slice(0, 5001), src.slice(5001)];
    expect((await drainStrChunks(_emitBase64ForTests(asyncOf(mid)))).toString("utf8"))
      .toBe(whole);
  });

  it("split-input parity holds for a source split at every single code unit", async () => {
    // Extreme case — every chunk is one code unit long. The high-surrogate
    // carry has to bridge across two consecutive one-char chunks; the
    // 3-byte-alignment carry has to bridge across dozens.
    const src = "a".repeat(500) + "🚀 café ☕ 日本語 😀" + "b".repeat(500);
    const whole = (await drainStrChunks(_emitBase64ForTests(src))).toString("utf8");
    const oneCharEach = Array.from(src);
    const out = (
      await drainStrChunks(_emitBase64ForTests(asyncOf(oneCharEach)))
    ).toString("utf8");
    expect(out).toBe(whole);
    // Confirm the emoji round-tripped through base64.
    const decoded = Buffer.from(out, "base64").toString("utf8");
    expect(decoded).toBe(src);
  });

  it("empty async source yields nothing", async () => {
    const out = await drainStrChunks(_emitBase64ForTests(asyncOf([])));
    expect(out.byteLength).toBe(0);
  });

  it("async source of only empty strings yields nothing", async () => {
    const out = await drainStrChunks(
      _emitBase64ForTests(asyncOf(["", "", ""]))
    );
    expect(out.byteLength).toBe(0);
  });

  it("split at every point across a source spanning a SLICE_RAW_BYTES boundary", async () => {
    // Cross the 48 KiB slice boundary with a source that has a surrogate pair
    // at a strategic location, then split it in a bunch of different places
    // — each split point exercises a different code path in the carry logic.
    const CHUNK_CODE_UNITS = Math.floor(SLICE_RAW_BYTES / 3); // 16384
    const filler = "x".repeat(CHUNK_CODE_UNITS + 100);
    const src = filler + "🚀" + "y".repeat(100);
    const whole = (await drainStrChunks(_emitBase64ForTests(src))).toString("utf8");

    // Split at various offsets around the slice boundary.
    for (const at of [1, 100, CHUNK_CODE_UNITS - 1, CHUNK_CODE_UNITS,
                     CHUNK_CODE_UNITS + 1, CHUNK_CODE_UNITS + 100,
                     CHUNK_CODE_UNITS + 101 /* mid pair */,
                     CHUNK_CODE_UNITS + 102, src.length - 1]) {
      const chunks = [src.slice(0, at), src.slice(at)];
      const out = (
        await drainStrChunks(_emitBase64ForTests(asyncOf(chunks)))
      ).toString("utf8");
      expect(out).toBe(whole);
    }
  });

  it("preserves byte-for-byte parity with buildFullMessage for the same mail", async () => {
    // The materializing path (`buildFullMessage`) and the streaming path
    // (`streamFromSegments`) must produce identical output — otherwise
    // `RFC822.SIZE` (cached from computeFullMessageSize) can disagree with
    // what BODY[] emits, breaking the {N} literal invariant.
    const mail: Partial<MailType> = {
      text: "plain body text",
      html: "<p>rich body</p>".repeat(3000), // ~48 KiB — crosses one slice boundary
    };
    const segments = buildMessageSegments(mail, "parity-test");
    const { concatenated } = await drainToBuffer(streamFromSegments(segments));
    const materialized = buildFullMessage(mail, "parity-test");
    expect(concatenated.toString("utf8")).toBe(materialized);
  });
});

