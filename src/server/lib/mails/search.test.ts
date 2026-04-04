import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the postgres repository
const mockSearchMails = mock(() => Promise.resolve([]));
const mockGetDomainUidNext = mock(() => Promise.resolve(42));
const mockGetAccountUidNext = mock(() => Promise.resolve(10));

mock.module("../postgres/repositories/mails", () => ({
  searchMails: mockSearchMails,
  getDomainUidNext: mockGetDomainUidNext,
  getAccountUidNext: mockGetAccountUidNext,
}));

// Mock the logger
mock.module("../logger", () => ({
  logger: {
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  },
}));

import { searchMail, getDomainUidNext, getAccountUidNext } from "./search";

const mockUser = {
  id: "user-123",
  username: "testuser",
  email: "test@example.com",
};

describe("searchMail", () => {
  beforeEach(() => {
    mockSearchMails.mockClear();
    mockSearchMails.mockResolvedValue([]);
  });

  it("should return empty array for empty search value", async () => {
    const result = await searchMail(mockUser as any, "");
    expect(result).toEqual([]);
    expect(mockSearchMails).not.toHaveBeenCalled();
  });

  it("should return empty array for whitespace-only search value", async () => {
    const result = await searchMail(mockUser as any, "   ");
    expect(result).toEqual([]);
    expect(mockSearchMails).not.toHaveBeenCalled();
  });

  it("should call searchMails with trimmed value", async () => {
    await searchMail(mockUser as any, "  hello  ");
    expect(mockSearchMails).toHaveBeenCalledWith("user-123", "hello", undefined);
  });

  it("should call searchMails with field when provided", async () => {
    await searchMail(mockUser as any, "test", "subject");
    expect(mockSearchMails).toHaveBeenCalledWith("user-123", "test", "subject");
  });

  it("should map SearchMailModel to MailHeaderData", async () => {
    const mockMailModel = {
      mail_id: "mail-abc",
      subject: "Test Subject",
      date: "2024-01-01T00:00:00Z",
      from_address: [{ address: "sender@example.com", name: "Sender" }],
      from_text: "Sender <sender@example.com>",
      to_address: [{ address: "recipient@example.com", name: "Recipient" }],
      to_text: "Recipient <recipient@example.com>",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: true,
      insight: null,
      highlight: "Test <em>Subject</em>",
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser as any, "subject");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mail-abc");
    expect(results[0].subject).toBe("Test Subject");
    expect(results[0].read).toBe(false);
    expect(results[0].saved).toBe(true);
    expect(results[0].highlight).toBe("Test <em>Subject</em>");
  });

  it("should handle null from/to addresses gracefully", async () => {
    const mockMailModel = {
      mail_id: "mail-xyz",
      subject: "No Addresses",
      date: "2024-01-01T00:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: true,
      saved: false,
      insight: null,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser as any, "test");
    expect(results).toHaveLength(1);
    expect(results[0].from).toBeUndefined();
    expect(results[0].to).toBeUndefined();
  });

  it("should map cc and bcc addresses when present", async () => {
    const mockMailModel = {
      mail_id: "mail-cc",
      subject: "With CC/BCC",
      date: "2024-01-01T00:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: [{ address: "cc@example.com" }],
      cc_text: "cc@example.com",
      bcc_address: [{ address: "bcc@example.com" }],
      bcc_text: "bcc@example.com",
      read: false,
      saved: false,
      insight: null,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser as any, "cc");
    expect(results[0].cc).toBeDefined();
    expect(results[0].bcc).toBeDefined();
  });

  it("should map insight when present", async () => {
    const insight = { category: "newsletter", summary: "A newsletter" };
    const mockMailModel = {
      mail_id: "mail-insight",
      subject: "Newsletter",
      date: "2024-01-01T00:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: false,
      insight,
      highlight: undefined,
    };
    mockSearchMails.mockResolvedValue([mockMailModel]);

    const results = await searchMail(mockUser as any, "newsletter");
    expect(results[0].insight).toEqual(insight);
  });

  it("should return multiple results", async () => {
    const models = [
      { mail_id: "m1", subject: "First", date: "2024-01-01", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: false, saved: false, insight: null, highlight: undefined },
      { mail_id: "m2", subject: "Second", date: "2024-01-02", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: true, saved: false, insight: null, highlight: undefined },
    ];
    mockSearchMails.mockResolvedValue(models);

    const results = await searchMail(mockUser as any, "query");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("m1");
    expect(results[1].id).toBe("m2");
  });
});

describe("getDomainUidNext", () => {
  beforeEach(() => {
    mockGetDomainUidNext.mockClear();
  });

  it("should return the result from pgGetDomainUidNext", async () => {
    mockGetDomainUidNext.mockResolvedValue(42);
    const result = await getDomainUidNext("user-123");
    expect(result).toBe(42);
    expect(mockGetDomainUidNext).toHaveBeenCalledWith("user-123", false);
  });

  it("should pass sent=true when specified", async () => {
    mockGetDomainUidNext.mockResolvedValue(5);
    await getDomainUidNext("user-123", true);
    expect(mockGetDomainUidNext).toHaveBeenCalledWith("user-123", true);
  });

  it("should return 1 on error", async () => {
    mockGetDomainUidNext.mockRejectedValue(new Error("DB error"));
    const result = await getDomainUidNext("user-123");
    expect(result).toBe(1);
  });
});

describe("getAccountUidNext", () => {
  beforeEach(() => {
    mockGetAccountUidNext.mockClear();
  });

  it("should return the result from pgGetAccountUidNext", async () => {
    mockGetAccountUidNext.mockResolvedValue(10);
    const result = await getAccountUidNext("user-123", "inbox");
    expect(result).toBe(10);
    expect(mockGetAccountUidNext).toHaveBeenCalledWith("user-123", "inbox", false);
  });

  it("should pass sent=true when specified", async () => {
    mockGetAccountUidNext.mockResolvedValue(3);
    await getAccountUidNext("user-123", "sent", true);
    expect(mockGetAccountUidNext).toHaveBeenCalledWith("user-123", "sent", true);
  });

  it("should return 1 on error", async () => {
    mockGetAccountUidNext.mockRejectedValue(new Error("DB error"));
    const result = await getAccountUidNext("user-123", "inbox");
    expect(result).toBe(1);
  });
});
