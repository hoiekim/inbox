import { describe, it, expect, mock, beforeEach } from "bun:test";
import { SignedUser } from "common";

const mockGetUnreadNotifications = mock(() => Promise.resolve(new Map()));

mock.module("../postgres/repositories/mails", () => ({
  getUnreadNotifications: mockGetUnreadNotifications,
}));

import { getNotifications } from "./notifications";

const makeUser = (id: string, username: string) => new SignedUser({ id, username, email: id + "@example.com" });

describe("getNotifications", () => {
  beforeEach(() => {
    mockGetUnreadNotifications.mockClear();
    mockGetUnreadNotifications.mockResolvedValue(new Map());
  });

  it("should return a Map with all users initialized to count=0", async () => {
    const users = [makeUser("u1", "alice"), makeUser("u2", "bob")];
    const result = await getNotifications(users);
    expect(result.get("alice")).toEqual({ count: 0 });
    expect(result.get("bob")).toEqual({ count: 0 });
  });

  it("should call getUnreadNotifications with all user IDs", async () => {
    const users = [makeUser("u1", "alice"), makeUser("u2", "bob")];
    await getNotifications(users);
    expect(mockGetUnreadNotifications).toHaveBeenCalledWith(["u1", "u2"]);
  });

  it("should map unread notifications back to usernames", async () => {
    const users = [makeUser("u1", "alice"), makeUser("u2", "bob")];
    const rawNotifications = new Map([
      ["u1", { count: 5, latest: new Date("2024-01-15") }],
    ]);
    mockGetUnreadNotifications.mockResolvedValue(rawNotifications);

    const result = await getNotifications(users);
    expect(result.get("alice")).toEqual({ count: 5, latest: new Date("2024-01-15") });
  });

  it("should not update users with no unread notifications", async () => {
    const users = [makeUser("u1", "alice"), makeUser("u2", "bob")];
    const rawNotifications = new Map([
      ["u1", { count: 3 }],
    ]);
    mockGetUnreadNotifications.mockResolvedValue(rawNotifications);

    const result = await getNotifications(users);
    expect(result.get("alice")).toEqual({ count: 3 });
    expect(result.get("bob")).toEqual({ count: 0 }); // default
  });

  it("should handle empty user list", async () => {
    const result = await getNotifications([]);
    expect(result.size).toBe(0);
    expect(mockGetUnreadNotifications).toHaveBeenCalledWith([]);
  });

  it("should handle single user", async () => {
    const users = [makeUser("u1", "charlie")];
    const rawNotifications = new Map([
      ["u1", { count: 2, latest: new Date("2024-01-10") }],
    ]);
    mockGetUnreadNotifications.mockResolvedValue(rawNotifications);

    const result = await getNotifications(users);
    expect(result.size).toBe(1);
    expect(result.get("charlie")).toEqual({ count: 2, latest: new Date("2024-01-10") });
  });

  it("should handle multiple users with notifications", async () => {
    const users = [
      makeUser("u1", "alice"),
      makeUser("u2", "bob"),
      makeUser("u3", "charlie"),
    ];
    const rawNotifications = new Map([
      ["u1", { count: 10, latest: new Date("2024-01-20") }],
      ["u2", { count: 2, latest: new Date("2024-01-18") }],
    ]);
    mockGetUnreadNotifications.mockResolvedValue(rawNotifications);

    const result = await getNotifications(users);
    expect(result.get("alice")?.count).toBe(10);
    expect(result.get("bob")?.count).toBe(2);
    expect(result.get("charlie")).toEqual({ count: 0 }); // no notifications
  });

  it("should return a Notifications Map type", async () => {
    const users = [makeUser("u1", "alice")];
    const result = await getNotifications(users);
    expect(result instanceof Map).toBe(true);
  });
});
