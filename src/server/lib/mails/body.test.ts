import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockGetMailById = mock(() => Promise.resolve(null));

mock.module("../postgres/repositories/mails", () => ({
  getMailById: mockGetMailById,
}));

import { getMailBody } from "./body";

describe("getMailBody", () => {
  beforeEach(() => {
    mockGetMailById.mockClear();
  });

  it("should return undefined when mail is not found", async () => {
    mockGetMailById.mockResolvedValue(null);
    const result = await getMailBody("user-123", "non-existent-id");
    expect(result).toBeUndefined();
  });

  it("should call getMailById with correct userId and mailId", async () => {
    mockGetMailById.mockResolvedValue(null);
    await getMailBody("user-abc", "mail-xyz");
    expect(mockGetMailById).toHaveBeenCalledWith("user-abc", "mail-xyz");
  });

  it("should return MailBodyData when mail is found", async () => {
    const mockModel = {
      mail_id: "mail-001",
      html: "<p>Hello, World!</p>",
      attachments: null,
      message_id: "<msg-001@example.com>",
      insight: null,
    };
    mockGetMailById.mockResolvedValue(mockModel);

    const result = await getMailBody("user-123", "mail-001");
    expect(result).toBeDefined();
    expect(result!.id).toBe("mail-001");
    expect(result!.html).toBe("<p>Hello, World!</p>");
    expect(result!.messageId).toBe("<msg-001@example.com>");
  });

  it("should map attachments when present", async () => {
    const attachments = [
      { filename: "file.pdf", contentType: "application/pdf", size: 1024 },
    ];
    const mockModel = {
      mail_id: "mail-002",
      html: "<p>See attached</p>",
      attachments,
      message_id: "<msg-002@example.com>",
      insight: null,
    };
    mockGetMailById.mockResolvedValue(mockModel);

    const result = await getMailBody("user-123", "mail-002");
    expect(result).toBeDefined();
    expect(result!.attachments).toEqual(attachments);
  });

  it("should map insight when present", async () => {
    const insight = { category: "invoice", summary: "Invoice #123" };
    const mockModel = {
      mail_id: "mail-003",
      html: "<p>Invoice attached</p>",
      attachments: null,
      message_id: "<msg-003@example.com>",
      insight,
    };
    mockGetMailById.mockResolvedValue(mockModel);

    const result = await getMailBody("user-123", "mail-003");
    expect(result!.insight).toEqual(insight);
  });

  it("should handle mail with no html (defaults to empty string)", async () => {
    const mockModel = {
      mail_id: "mail-004",
      html: null,
      attachments: null,
      message_id: "<msg-004@example.com>",
      insight: null,
    };
    mockGetMailById.mockResolvedValue(mockModel);

    const result = await getMailBody("user-123", "mail-004");
    expect(result).toBeDefined();
    // MailBodyData constructor coerces null/undefined html to ""
    expect(result!.html).toBe("");
  });
});
