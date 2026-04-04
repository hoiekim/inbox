import { describe, it, expect, mock, beforeEach } from "bun:test";
import { SignedUser } from "common";

const mockGetAccountStats = mock(() => Promise.resolve([]));

mock.module("../postgres/repositories/mails", () => ({
  getAccountStats: mockGetAccountStats,
}));

// Mock getUserDomain from "server" — only mock what accounts.ts actually imports
mock.module("server", () => ({
  getUserDomain: (username: string) =>
    username === "admin" ? "example.com" : `${username}.example.com`,
}));

import { getAccounts } from "./accounts";

const mockUser = new SignedUser({
  id: "user-123",
  username: "testuser",
  email: "testuser@testuser.example.com",
});

const adminUser = new SignedUser({
  id: "admin-1",
  username: "admin",
  email: "admin@example.com",
});

describe("getAccounts", () => {
  beforeEach(() => {
    mockGetAccountStats.mockClear();
    mockGetAccountStats.mockResolvedValue([]);
  });

  it("should call getAccountStats twice (received and sent)", async () => {
    await getAccounts(mockUser);
    expect(mockGetAccountStats).toHaveBeenCalledTimes(2);
  });

  it("should call getAccountStats with correct userId and sent flags", async () => {
    await getAccounts(mockUser);
    expect(mockGetAccountStats).toHaveBeenCalledWith("user-123", false, "testuser.example.com");
    expect(mockGetAccountStats).toHaveBeenCalledWith("user-123", true, "testuser.example.com");
  });

  it("should return empty received and sent arrays when no stats", async () => {
    const result = await getAccounts(mockUser);
    expect(result.received).toEqual([]);
    expect(result.sent).toEqual([]);
  });

  it("should map received stats to Account objects", async () => {
    const receivedStats = [
      { address: "inbox@testuser.example.com", count: 10, unread: 3, saved: 1, latest: "2024-01-15" },
    ];
    const sentStats: never[] = [];

    mockGetAccountStats
      .mockResolvedValueOnce(receivedStats)
      .mockResolvedValueOnce(sentStats);

    const result = await getAccounts(mockUser);
    expect(result.received).toHaveLength(1);
    expect(result.received[0].key).toBe("inbox@testuser.example.com");
    expect(result.received[0].doc_count).toBe(10);
    expect(result.received[0].unread_doc_count).toBe(3);
    expect(result.received[0].saved_doc_count).toBe(1);
    expect(result.received[0].updated).toBe("2024-01-15");
  });

  it("should map sent stats to Account objects", async () => {
    const receivedStats: never[] = [];
    const sentStats = [
      { address: "sent@testuser.example.com", count: 5, unread: 0, saved: 2, latest: "2024-01-10" },
    ];

    mockGetAccountStats
      .mockResolvedValueOnce(receivedStats)
      .mockResolvedValueOnce(sentStats);

    const result = await getAccounts(mockUser);
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].key).toBe("sent@testuser.example.com");
    expect(result.sent[0].doc_count).toBe(5);
  });

  it("should map multiple accounts", async () => {
    const receivedStats = [
      { address: "a@testuser.example.com", count: 5, unread: 1, saved: 0, latest: "2024-01-01" },
      { address: "b@testuser.example.com", count: 8, unread: 2, saved: 1, latest: "2024-01-02" },
    ];

    mockGetAccountStats
      .mockResolvedValueOnce(receivedStats)
      .mockResolvedValueOnce([]);

    const result = await getAccounts(mockUser);
    expect(result.received).toHaveLength(2);
    expect(result.received[0].key).toBe("a@testuser.example.com");
    expect(result.received[1].key).toBe("b@testuser.example.com");
  });

  it("should use base domain for admin user", async () => {
    await getAccounts(adminUser);
    expect(mockGetAccountStats).toHaveBeenCalledWith("admin-1", false, "example.com");
    expect(mockGetAccountStats).toHaveBeenCalledWith("admin-1", true, "example.com");
  });

  it("should return both received and sent in the same response", async () => {
    const receivedStats = [
      { address: "recv@example.com", count: 3, unread: 1, saved: 0, latest: "2024-01-05" },
    ];
    const sentStats = [
      { address: "sent@example.com", count: 7, unread: 0, saved: 2, latest: "2024-01-06" },
    ];

    mockGetAccountStats
      .mockResolvedValueOnce(receivedStats)
      .mockResolvedValueOnce(sentStats);

    const result = await getAccounts(mockUser);
    expect(result.received).toHaveLength(1);
    expect(result.sent).toHaveLength(1);
    expect(result.received[0].key).toBe("recv@example.com");
    expect(result.sent[0].key).toBe("sent@example.com");
  });
});
