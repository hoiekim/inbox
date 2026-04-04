import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Pagination } from "common";

const mockGetMailHeaders = mock(() => Promise.resolve([]));

mock.module("../postgres/repositories/mails", () => ({
  getMailHeaders: mockGetMailHeaders,
}));

import { getMailHeaders } from "./headers";

const makeUser = (overrides: object = {}) => ({
  id: "user-123",
  username: "testuser",
  email: "test@example.com",
  ...overrides,
});

const makeMaskedUser = (overrides: object = {}) => ({
  user_id: "user-456",
  username: "maskeduser",
  ...overrides,
});

const defaultOptions = {
  sent: false,
  new: false,
  saved: false,
};

describe("getMailHeaders", () => {
  beforeEach(() => {
    mockGetMailHeaders.mockClear();
    mockGetMailHeaders.mockResolvedValue([]);
  });

  it("should return empty array when user has no id", async () => {
    const user = { username: "noId" };
    const result = await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    expect(result).toEqual([]);
    expect(mockGetMailHeaders).not.toHaveBeenCalled();
  });

  it("should call pgGetMailHeaders with correct parameters for SignedUser", async () => {
    const user = makeUser();
    await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ sent: false, new: false, saved: false })
    );
  });

  it("should call pgGetMailHeaders with user_id for MaskedUser", async () => {
    const user = makeMaskedUser();
    await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-456",
      "inbox@example.com",
      expect.any(Object)
    );
  });

  it("should use default pagination when not provided", async () => {
    const user = makeUser();
    await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    const defaultPagination = new Pagination();
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({
        from: defaultPagination.from,
        size: defaultPagination.size,
      })
    );
  });

  it("should pass pagination options correctly", async () => {
    const user = makeUser();
    const pagination = new Pagination();
    pagination.from = 20;
    pagination.size = 10;

    await getMailHeaders(user as any, "inbox@example.com", {
      ...defaultOptions,
      pagination,
    });

    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ from: 20, size: 10 })
    );
  });

  it("should map mail models to MailHeaderData", async () => {
    const mailModel = {
      mail_id: "mail-abc",
      subject: "Test Email",
      date: "2024-01-15T10:00:00Z",
      from_address: [{ address: "sender@example.com", name: "Sender" }],
      from_text: "Sender <sender@example.com>",
      to_address: [{ address: "recv@example.com", name: "Recv" }],
      to_text: "Recv <recv@example.com>",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: true,
      saved: false,
      sent: false,
      insight: null,
    };
    mockGetMailHeaders.mockResolvedValue([mailModel]);

    const user = makeUser();
    const results = await getMailHeaders(user as any, "recv@example.com", defaultOptions);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mail-abc");
    expect(results[0].subject).toBe("Test Email");
    expect(results[0].read).toBe(true);
    expect(results[0].saved).toBe(false);
    expect(results[0].sent).toBe(false);
  });

  it("should handle null from/to addresses", async () => {
    const mailModel = {
      mail_id: "mail-null",
      subject: "Null Addresses",
      date: "2024-01-15T10:00:00Z",
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
      sent: false,
      insight: null,
    };
    mockGetMailHeaders.mockResolvedValue([mailModel]);

    const user = makeUser();
    const results = await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    expect(results[0].from).toBeUndefined();
    expect(results[0].to).toBeUndefined();
    expect(results[0].cc).toBeUndefined();
    expect(results[0].bcc).toBeUndefined();
  });

  it("should map cc and bcc when present", async () => {
    const mailModel = {
      mail_id: "mail-ccbcc",
      subject: "CC/BCC Email",
      date: "2024-01-15T10:00:00Z",
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
      sent: false,
      insight: null,
    };
    mockGetMailHeaders.mockResolvedValue([mailModel]);

    const user = makeUser();
    const results = await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    expect(results[0].cc).toBeDefined();
    expect(results[0].bcc).toBeDefined();
  });

  it("should pass sent=true option", async () => {
    const user = makeUser();
    await getMailHeaders(user as any, "sent@example.com", { ...defaultOptions, sent: true });
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "sent@example.com",
      expect.objectContaining({ sent: true })
    );
  });

  it("should pass saved=true option", async () => {
    const user = makeUser();
    await getMailHeaders(user as any, "inbox@example.com", { ...defaultOptions, saved: true });
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ saved: true })
    );
  });

  it("should return multiple results", async () => {
    const models = [
      { mail_id: "m1", subject: "First", date: "2024-01-01", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: false, saved: false, sent: false, insight: null },
      { mail_id: "m2", subject: "Second", date: "2024-01-02", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: true, saved: true, sent: false, insight: null },
    ];
    mockGetMailHeaders.mockResolvedValue(models);

    const user = makeUser();
    const results = await getMailHeaders(user as any, "inbox@example.com", defaultOptions);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("m1");
    expect(results[1].id).toBe("m2");
  });
});
