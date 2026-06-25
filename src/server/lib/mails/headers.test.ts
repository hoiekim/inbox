import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Pagination, SignedUser, MaskedUser } from "common";

const mockGetMailHeaders = mock(() => Promise.resolve([]));
const mockGetMailHeadersDelta = mock(() =>
  Promise.resolve({ as_of: "2024-01-02T00:00:00.000Z", headers: [], expunged_ids: [] })
);

mock.module("../postgres/repositories/mails", () => ({
  getMailHeaders: mockGetMailHeaders,
  getMailHeadersDelta: mockGetMailHeadersDelta,
}));

import { getMailHeaders, getMailHeadersDelta } from "./headers";

const makeUser = (overrides: Partial<SignedUser> = {}) => new SignedUser({
  id: "user-123",
  username: "testuser",
  email: "test@example.com",
  ...overrides,
});

const makeMaskedUser = (overrides: Partial<MaskedUser> = {}) => new MaskedUser({
  id: "user-456",
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
    const result = await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(result).toEqual([]);
    expect(mockGetMailHeaders).not.toHaveBeenCalled();
  });

  it("should call pgGetMailHeaders with correct parameters for SignedUser", async () => {
    const user = makeUser();
    await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ sent: false, new: false, saved: false })
    );
  });

  it("should call pgGetMailHeaders with user_id for MaskedUser", async () => {
    const user = makeMaskedUser();
    await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-456",
      "inbox@example.com",
      expect.any(Object)
    );
  });

  it("should use default pagination when not provided", async () => {
    const user = makeUser();
    await getMailHeaders(user, "inbox@example.com", defaultOptions);
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

    await getMailHeaders(user, "inbox@example.com", {
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
    const results = await getMailHeaders(user, "recv@example.com", defaultOptions);
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
    const results = await getMailHeaders(user, "inbox@example.com", defaultOptions);
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
    const results = await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(results[0].cc).toBeDefined();
    expect(results[0].bcc).toBeDefined();
  });

  it("should pass sent=true option", async () => {
    const user = makeUser();
    await getMailHeaders(user, "sent@example.com", { ...defaultOptions, sent: true });
    expect(mockGetMailHeaders).toHaveBeenCalledWith(
      "user-123",
      "sent@example.com",
      expect.objectContaining({ sent: true })
    );
  });

  it("should pass saved=true option", async () => {
    const user = makeUser();
    await getMailHeaders(user, "inbox@example.com", { ...defaultOptions, saved: true });
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
    const results = await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("m1");
    expect(results[1].id).toBe("m2");
  });
});

describe("getMailHeadersDelta", () => {
  const since = "2024-01-01T00:00:00.000Z";

  beforeEach(() => {
    mockGetMailHeadersDelta.mockClear();
    mockGetMailHeadersDelta.mockResolvedValue({
      as_of: "2024-01-02T00:00:00.000Z",
      headers: [],
      expunged_ids: [],
    });
  });

  it("returns an empty delta that echoes `since` when user has no id", async () => {
    const user = { username: "noId" };
    const result = await getMailHeadersDelta(user, "inbox@example.com", defaultOptions, since);
    // as_of must NOT advance past `since`, or the client would skip unseen rows.
    expect(result).toEqual({ as_of: since, headers: [], expunged_ids: [] });
    expect(mockGetMailHeadersDelta).not.toHaveBeenCalled();
  });

  it("passes since + folder options to the repository (and never paginates)", async () => {
    const user = makeUser();
    await getMailHeadersDelta(
      user,
      "inbox@example.com",
      { ...defaultOptions, sent: true },
      since
    );
    const callArgs = mockGetMailHeadersDelta.mock.calls[0];
    expect(callArgs[0]).toBe("user-123");
    expect(callArgs[1]).toBe("inbox@example.com");
    expect(callArgs[2]).toMatchObject({ sent: true, new: false, saved: false });
    // Delta returns the full changed set, so it must NOT carry pagination.
    expect(callArgs[2]).not.toHaveProperty("from");
    expect(callArgs[2]).not.toHaveProperty("size");
    expect(callArgs[3]).toBe(since);
  });

  it("maps repository header rows to MailHeaderData and passes through as_of + expunged_ids", async () => {
    mockGetMailHeadersDelta.mockResolvedValue({
      as_of: "2024-01-03T12:00:00.000Z",
      headers: [
        {
          mail_id: "mail-delta",
          subject: "Changed",
          date: "2024-01-03T10:00:00Z",
          from_address: [{ address: "s@example.com" }],
          from_text: "s@example.com",
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
        },
      ],
      expunged_ids: ["gone-1", "gone-2"],
    });

    const user = makeUser();
    const result = await getMailHeadersDelta(user, "inbox@example.com", defaultOptions, since);
    expect(result.as_of).toBe("2024-01-03T12:00:00.000Z");
    expect(result.expunged_ids).toEqual(["gone-1", "gone-2"]);
    expect(result.headers).toHaveLength(1);
    expect(result.headers[0].id).toBe("mail-delta");
    expect(result.headers[0].subject).toBe("Changed");
    expect(result.headers[0].from).toBeDefined();
  });
});
