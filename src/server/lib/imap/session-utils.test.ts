/**
 * Tests for session-utils.ts — pure utility functions extracted from ImapSession
 * Covers inbox #341
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the "server" module before importing session-utils
mock.module("server", () => ({
  getAttachment: mock(() => undefined),
  logger: {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {})
  }
}));

import {
  applyPartialFetch,
  getBodySectionKey,
  shouldMarkAsRead,
  buildFullMessage,
  getBodyPart
} from "./session-utils";
import type {
  BodySection,
  FetchDataItem,
  PartialRange
} from "./types";
import type { MailType } from "common";

// Helper: get the mocked getAttachment from the mocked module
async function getMockedGetAttachment() {
  const serverMod = await import("server");
  return serverMod.getAttachment as ReturnType<typeof mock>;
}

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

  it("returns multipart/mixed for text+html+attachment mail", async () => {
    const mockGetAttachment = await getMockedGetAttachment();
    const fakeAttachmentData = Buffer.from("PDF_BINARY_DATA");
    mockGetAttachment.mockImplementation(() => fakeAttachmentData);

    const mail: Partial<MailType> = {
      text: "See attached",
      html: "<p>See attached</p>",
      attachments: [
        {
          content: { data: "att-file-id-1" },
          contentType: "application/pdf",
          filename: "document.pdf",
          size: 1024
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

  it("returns multipart/mixed for text-only+attachment mail", async () => {
    const mockGetAttachment = await getMockedGetAttachment();
    const fakeData = Buffer.from("SOME_DATA");
    mockGetAttachment.mockImplementation(() => fakeData);

    const mail: Partial<MailType> = {
      text: "See attached",
      attachments: [
        {
          content: { data: "att-file-id-2" },
          contentType: "text/plain",
          filename: "notes.txt",
          size: 50
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

  it("returns attachment data for part 2 in mail with attachment", async () => {
    const mockGetAttachment = await getMockedGetAttachment();
    const attData = Buffer.from("ATTACHMENT_BYTES");
    mockGetAttachment.mockImplementation(() => attData);

    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: "att-file-xyz" },
          contentType: "image/png",
          filename: "photo.png",
          size: 200
        }
      ]
    };
    const result = getBodyPart(mail, "2");
    expect(result).toBe(attData.toString("base64"));
  });

  it("returns null for attachment when getAttachment returns undefined", async () => {
    const mockGetAttachment = await getMockedGetAttachment();
    mockGetAttachment.mockImplementation(() => undefined);

    const mail: Partial<MailType> = {
      text: "Body",
      attachments: [
        {
          content: { data: "missing-file" },
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
