import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockGetSpamMails = mock(() => Promise.resolve([]));
const mockMarkMailSpam = mock(() => Promise.resolve(true));

mock.module("../postgres/repositories/mails", () => ({
  getSpamMails: mockGetSpamMails,
  markMailSpam: mockMarkMailSpam,
}));

import { getSpamHeaders, markSpam } from "./spam";
import { MaskedUser } from "common";

const mockUser = new MaskedUser({ id: "user-123", username: "testuser" });

describe("getSpamHeaders", () => {
  beforeEach(() => {
    mockGetSpamMails.mockClear();
    mockGetSpamMails.mockResolvedValue([]);
  });

  it("should return empty array when user has no id", async () => {
    const result = await getSpamHeaders(new MaskedUser({ username: "noId" }));
    expect(result).toEqual([]);
    expect(mockGetSpamMails).not.toHaveBeenCalled();
  });

  it("should call getSpamMails with user id", async () => {
    await getSpamHeaders(mockUser);
    expect(mockGetSpamMails).toHaveBeenCalledWith("user-123");
  });

  it("should return empty array when no spam mails found", async () => {
    const result = await getSpamHeaders(mockUser);
    expect(result).toEqual([]);
  });

  it("should map spam mail models to MailHeaderData", async () => {
    const spamModel = {
      mail_id: "spam-001",
      subject: "You won a million dollars!",
      date: "2024-01-05T08:00:00Z",
      from_address: [{ address: "spammer@bad.com", name: "Spammer" }],
      from_text: "Spammer <spammer@bad.com>",
      to_address: [{ address: "victim@example.com" }],
      to_text: "victim@example.com",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: false,
      insight: null,
    };
    mockGetSpamMails.mockResolvedValue([spamModel]);

    const results = await getSpamHeaders(mockUser);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("spam-001");
    expect(results[0].subject).toBe("You won a million dollars!");
    expect(results[0].read).toBe(false);
    expect(results[0].saved).toBe(false);
  });

  it("should handle null from/to addresses", async () => {
    const spamModel = {
      mail_id: "spam-002",
      subject: "Spam",
      date: "2024-01-06T10:00:00Z",
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
      insight: null,
    };
    mockGetSpamMails.mockResolvedValue([spamModel]);

    const results = await getSpamHeaders(mockUser);
    expect(results[0].from).toBeUndefined();
    expect(results[0].to).toBeUndefined();
  });

  it("should map cc and bcc when present", async () => {
    const spamModel = {
      mail_id: "spam-003",
      subject: "Spam with CC",
      date: "2024-01-07T10:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: [{ address: "cc@bad.com" }],
      cc_text: "cc@bad.com",
      bcc_address: [{ address: "bcc@bad.com" }],
      bcc_text: "bcc@bad.com",
      read: false,
      saved: false,
      insight: null,
    };
    mockGetSpamMails.mockResolvedValue([spamModel]);

    const results = await getSpamHeaders(mockUser);
    expect(results[0].cc).toBeDefined();
    expect(results[0].bcc).toBeDefined();
  });

  it("should map insight when present", async () => {
    const insight = { category: "spam", summary: "Obvious spam" };
    const spamModel = {
      mail_id: "spam-004",
      subject: "Spam",
      date: "2024-01-07T10:00:00Z",
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
    };
    mockGetSpamMails.mockResolvedValue([spamModel]);

    const results = await getSpamHeaders(mockUser);
    expect(results[0].insight).toEqual(insight);
  });

  it("should return multiple spam mails", async () => {
    const models = [
      { mail_id: "s1", subject: "Spam 1", date: "2024-01-01", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: false, saved: false, insight: null },
      { mail_id: "s2", subject: "Spam 2", date: "2024-01-02", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: false, saved: false, insight: null },
    ];
    mockGetSpamMails.mockResolvedValue(models);

    const results = await getSpamHeaders(mockUser);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("s1");
    expect(results[1].id).toBe("s2");
  });
});

describe("markSpam", () => {
  beforeEach(() => {
    mockMarkMailSpam.mockClear();
  });

  it("should call markMailSpam with correct args when marking as spam", async () => {
    await markSpam("user-123", "mail-abc", true);
    expect(mockMarkMailSpam).toHaveBeenCalledWith("user-123", "mail-abc", true);
  });

  it("should call markMailSpam with correct args when unmarking spam", async () => {
    await markSpam("user-123", "mail-abc", false);
    expect(mockMarkMailSpam).toHaveBeenCalledWith("user-123", "mail-abc", false);
  });

  it("should return true when successful", async () => {
    mockMarkMailSpam.mockResolvedValue(true);
    const result = await markSpam("user-123", "mail-abc", true);
    expect(result).toBe(true);
  });

  it("should return false when operation fails", async () => {
    mockMarkMailSpam.mockResolvedValue(false);
    const result = await markSpam("user-123", "mail-abc", true);
    expect(result).toBe(false);
  });

  it("should propagate errors from markMailSpam", async () => {
    mockMarkMailSpam.mockRejectedValue(new Error("DB error"));
    await expect(markSpam("user-123", "mail-abc", true)).rejects.toThrow("DB error");
  });
});
