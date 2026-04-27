/**
 * Tests for store.ts — IMAP Store class.
 *
 * Regression coverage for: listMailboxes must filter getAccountStats by the
 * user's domain so external CC/BCC/recipient addresses on stored mails do
 * not leak into the IMAP mailbox listing. PR #310 originally added this
 * filter; PR #196 (CREATE/DELETE/RENAME mailboxes) inadvertently removed it.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { SignedUser } from "common";

const mockGetAccountStats = mock(() => Promise.resolve([]));
const mockCountMessages = mock(() => Promise.resolve({ total: 0, unread: 0, maxUid: 0 }));
const mockGetMailsByRange = mock(() => Promise.resolve(new Map()));
const mockSetMailFlags = mock(() => Promise.resolve());
const mockSearchMailsByUid = mock(() => Promise.resolve([]));
const mockSaveMail = mock(() => Promise.resolve({ _id: "x" }));
const mockExpunge = mock(() => Promise.resolve(0));
const mockGetAllUids = mock(() => Promise.resolve([]));

mock.module("../postgres/repositories/mails", () => ({
  getAccountStats: mockGetAccountStats,
  countMessages: mockCountMessages,
  getMailsByRange: mockGetMailsByRange,
  setMailFlags: mockSetMailFlags,
  searchMailsByUid: mockSearchMailsByUid,
  saveMail: mockSaveMail,
  expungeDeletedMails: mockExpunge,
  getAllUids: mockGetAllUids,
}));

const mockGetMailboxesByUser = mock(() => Promise.resolve([]));
mock.module("../postgres/repositories/mailboxes", () => ({
  getMailboxesByUser: mockGetMailboxesByUser,
}));

mock.module("server", () => ({
  logger: { warn: mock(() => {}), error: mock(() => {}), info: mock(() => {}), debug: mock(() => {}) },
  getUserDomain: (username: string) =>
    username === "admin" ? "example.com" : `${username}.example.com`,
}));

import { Store } from "./store";

const makeUser = (overrides: Partial<{ id: string; username: string; email: string }> = {}) =>
  new SignedUser({
    id: "user-123",
    username: "alice",
    email: "alice@alice.example.com",
    ...overrides,
  });

describe("Store.listMailboxes", () => {
  beforeEach(() => {
    mockGetAccountStats.mockClear();
    mockGetMailboxesByUser.mockClear();
    mockGetAccountStats.mockResolvedValue([]);
    mockGetMailboxesByUser.mockResolvedValue([]);
  });

  it("passes the user's domain as the third arg to both getAccountStats calls (regression PR #310 / #196)", async () => {
    const store = new Store(makeUser());
    await store.listMailboxes();

    expect(mockGetAccountStats).toHaveBeenCalledTimes(2);
    expect(mockGetAccountStats).toHaveBeenCalledWith("user-123", false, "alice.example.com");
    expect(mockGetAccountStats).toHaveBeenCalledWith("user-123", true, "alice.example.com");
  });

  it("uses the bare EMAIL_DOMAIN for the admin user, not 'admin.<domain>'", async () => {
    const store = new Store(
      makeUser({ id: "admin-1", username: "admin", email: "admin@example.com" })
    );
    await store.listMailboxes();

    expect(mockGetAccountStats).toHaveBeenCalledWith("admin-1", false, "example.com");
    expect(mockGetAccountStats).toHaveBeenCalledWith("admin-1", true, "example.com");
  });

  it("returns ['INBOX'] when no accounts and no user mailboxes exist", async () => {
    const store = new Store(makeUser());
    const result = await store.listMailboxes();
    expect(result).toEqual(["INBOX"]);
  });
});
