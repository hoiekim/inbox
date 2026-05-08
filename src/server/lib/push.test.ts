import { describe, it, expect, mock, beforeEach, beforeAll } from "bun:test";
import type { PushSubscription } from "web-push";
import type { SignedUser, ComputedPushSubscription } from "common";
import {
  webPushSpies,
  idleManagerSpies,
  pushSubscriptionSpies,
} from "../../../scripts/test-setup";

// `web-push`, `./imap/idle-manager`, and `./postgres/repositories/push_subscriptions`
// are mocked once globally in `scripts/test-setup.ts`. We import the spy refs
// from there to assert on them. The shared internal modules push.ts also
// touches (`./postgres/repositories/mails`, `./users`, `server`) are NOT
// mocked at the package level — they're injected per-test via
// `setPushDependencies(...)` because globalising those would clobber the
// per-file mocks declared in mails/*.test.ts, users.test.ts, and any test
// that imports anything from the `server` barrel.

const mockSetVapidDetails = webPushSpies.setVapidDetails;
const mockSendNotification = webPushSpies.sendNotification;
const mockNotifyNewMail = idleManagerSpies.notifyNewMail;
const mockPgStoreSubscription = pushSubscriptionSpies.storeSubscription;
const mockPgDeleteSubscription = pushSubscriptionSpies.deleteSubscription;
const mockPgGetSubscriptions = pushSubscriptionSpies.getSubscriptions;
const mockPgRefreshSubscription = pushSubscriptionSpies.refreshSubscription;
const mockUpdateLastNotified = pushSubscriptionSpies.updateLastNotified;

const mockGetUnreadNotifications = mock(
  async (): Promise<Map<string, { count: number; latest?: Date }>> => new Map(),
);
const mockGetActiveUsers = mock(async (): Promise<SignedUser[]> => []);
const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

type PushModule = typeof import("./push");
let push: PushModule;

beforeAll(async () => {
  push = await import("./push");
  // Inject the shared-module deps that can't be globalised. web-push and the
  // push_subscriptions repo are already mocked at the package level via the
  // preload, so they don't need to go through this setter.
  push.setPushDependencies({
    getUnreadNotifications: mockGetUnreadNotifications as never,
    getActiveUsers: mockGetActiveUsers as never,
    logger: mockLogger as never,
    updateLastNotified: mockUpdateLastNotified as never,
  });
  // initPush() is invoked from start.ts at boot rather than at module load,
  // so the test must call it explicitly.
  push.initPush();
});

const makeUser = (overrides: Partial<SignedUser> = {}): SignedUser =>
  ({
    id: "u1",
    username: "alice",
    ...overrides,
  }) as SignedUser;

const makeSubscription = (
  overrides: Partial<ComputedPushSubscription> = {}
): ComputedPushSubscription =>
  ({
    push_subscription_id: "sub-1",
    username: "alice",
    endpoint: "https://push.example.com/sub-1",
    keys: { p256dh: "p", auth: "a" },
    lastNotified: new Date(0),
    ...overrides,
  }) as ComputedPushSubscription;

const resetAllMocks = () => {
  mockSendNotification.mockReset();
  mockSendNotification.mockResolvedValue({ statusCode: 201 } as never);
  mockPgStoreSubscription.mockClear();
  mockPgDeleteSubscription.mockReset();
  mockPgDeleteSubscription.mockResolvedValue(true as never);
  mockPgGetSubscriptions.mockReset();
  mockPgGetSubscriptions.mockResolvedValue([] as never);
  mockPgRefreshSubscription.mockClear();
  mockUpdateLastNotified.mockReset();
  mockUpdateLastNotified.mockResolvedValue(undefined as never);
  mockGetUnreadNotifications.mockReset();
  mockGetUnreadNotifications.mockResolvedValue(new Map() as never);
  mockGetActiveUsers.mockReset();
  mockGetActiveUsers.mockResolvedValue([] as never);
  mockNotifyNewMail.mockClear();
  mockLogger.error.mockClear();
  mockLogger.info.mockClear();
};

describe("push module init", () => {
  it("calls webPush.setVapidDetails when both VAPID keys are set", () => {
    expect(mockSetVapidDetails).toHaveBeenCalled();
    const call = mockSetVapidDetails.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe("mailto:admin@test.com");
    expect(typeof call[1]).toBe("string");
    expect(typeof call[2]).toBe("string");
    expect(call[1]!.length).toBeGreaterThan(0);
    expect(call[2]!.length).toBeGreaterThan(0);
  });
});

describe("getPushPublicKey", () => {
  it("returns the public VAPID key from env", () => {
    expect(typeof push.getPushPublicKey()).toBe("string");
    expect((push.getPushPublicKey() ?? "").length).toBeGreaterThan(0);
  });
});

describe("isPushEnabled", () => {
  it("returns true when both VAPID keys are set", () => {
    expect(push.isPushEnabled()).toBe(true);
  });
});

describe("storeSubscription", () => {
  beforeEach(resetAllMocks);

  it("delegates to repository with the same arguments", async () => {
    const sub = {
      endpoint: "https://x",
      keys: { p256dh: "p", auth: "a" },
    } as PushSubscription;
    const result = await push.storeSubscription("user-1", sub);
    expect(mockPgStoreSubscription).toHaveBeenCalledTimes(1);
    expect(mockPgStoreSubscription.mock.calls[0]).toEqual(["user-1", sub] as never);
    expect(result).toEqual({ _id: "sub-1" } as never);
  });
});

describe("deleteSubscription", () => {
  beforeEach(resetAllMocks);

  it("delegates to repository and returns its result", async () => {
    const result = await push.deleteSubscription("sub-1");
    expect(mockPgDeleteSubscription).toHaveBeenCalledTimes(1);
    expect(mockPgDeleteSubscription.mock.calls[0]).toEqual(["sub-1"] as never);
    expect(result).toBe(true as never);
  });

  it("logs and swallows errors from the repository", async () => {
    const err = new Error("db down");
    mockPgDeleteSubscription.mockRejectedValueOnce(err as never);
    const result = await push.deleteSubscription("sub-1");
    expect(result).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const args = mockLogger.error.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("Error deleting push subscription");
    expect(args[2]).toBe(err);
  });
});

describe("getSubscriptions", () => {
  beforeEach(resetAllMocks);

  it("delegates to repository with the user list", async () => {
    const users = [makeUser()];
    const subs = [makeSubscription()];
    mockPgGetSubscriptions.mockResolvedValueOnce(subs as never);
    const result = await push.getSubscriptions(users);
    expect(mockPgGetSubscriptions).toHaveBeenCalledTimes(1);
    expect(mockPgGetSubscriptions.mock.calls[0]).toEqual([users] as never);
    expect(result).toBe(subs as never);
  });
});

describe("refreshSubscription", () => {
  beforeEach(resetAllMocks);

  it("delegates to repository", async () => {
    await push.refreshSubscription("sub-1");
    expect(mockPgRefreshSubscription).toHaveBeenCalledTimes(1);
    expect(mockPgRefreshSubscription.mock.calls[0]).toEqual(["sub-1"] as never);
  });
});

describe("getNotifications", () => {
  beforeEach(resetAllMocks);

  it("maps user-id keys to username-keyed entries", async () => {
    const latest = new Date("2026-05-05T00:00:00Z");
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([["u1", { count: 3, latest }]]) as never
    );
    const users = [makeUser({ id: "u1", username: "alice" })];
    const result = await push.getNotifications(users);
    expect(result.get("alice")).toEqual({ count: 3, latest });
    expect(mockGetUnreadNotifications).toHaveBeenCalledTimes(1);
    expect(mockGetUnreadNotifications.mock.calls[0]).toEqual([["u1"]] as never);
  });

  it("returns count: 0 entry for users with no unread mail", async () => {
    mockGetUnreadNotifications.mockResolvedValueOnce(new Map() as never);
    const users = [
      makeUser({ id: "u1", username: "alice" }),
      makeUser({ id: "u2", username: "bob" }),
    ];
    const result = await push.getNotifications(users);
    expect(result.get("alice")).toEqual({ count: 0 });
    expect(result.get("bob")).toEqual({ count: 0 });
  });
});

describe("notifyNewMails", () => {
  beforeEach(resetAllMocks);

  it("notifies idleManager regardless of subscription state", async () => {
    await push.notifyNewMails(["alice"], ["INBOX"]);
    expect(mockNotifyNewMail).toHaveBeenCalledTimes(1);
    expect(mockNotifyNewMail.mock.calls[0]).toEqual([["alice"], ["INBOX"]] as never);
  });

  it("sends a push, then updates lastNotified, when there is fresh unread mail", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "sub-1",
      username: "alice",
      lastNotified: new Date("2026-05-04T00:00:00Z"),
    });
    mockGetActiveUsers.mockResolvedValueOnce([user] as never);
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([
        ["u1", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }],
      ]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.notifyNewMails(["alice"]);

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendNotification.mock.calls[0] as unknown as unknown[];
    expect(sendArgs[0]).toBe(subscription);
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.title).toBe("You have a new mail");
    expect(payload.badge_count).toBe(2);
    expect(payload.push_subscription_id).toBe("sub-1");
    expect(mockUpdateLastNotified).toHaveBeenCalledTimes(1);
    expect(mockUpdateLastNotified.mock.calls[0]).toEqual(["sub-1"] as never);
  });

  it("uses plural message when count > 1", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mockGetActiveUsers.mockResolvedValueOnce([user] as never);
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([
        ["u1", { count: 4, latest: new Date("2026-05-05T00:00:00Z") }],
      ]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.notifyNewMails(["alice"]);

    const sendArgs = mockSendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.title).toBe("You have 5 new mails");
    expect(payload.badge_count).toBe(5);
  });

  it("skips notification when no fresh unread mail (latest <= lastNotified)", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const same = new Date("2026-05-05T00:00:00Z");
    const subscription = makeSubscription({
      username: "alice",
      lastNotified: same,
    });
    mockGetActiveUsers.mockResolvedValueOnce([user] as never);
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([["u1", { count: 1, latest: same }]]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.notifyNewMails(["alice"]);

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockUpdateLastNotified).not.toHaveBeenCalled();
  });

  it("skips a subscription whose user has no notification entry", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "ghost" });
    mockGetActiveUsers.mockResolvedValueOnce([user] as never);
    mockGetUnreadNotifications.mockResolvedValueOnce(new Map() as never);
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.notifyNewMails(["alice"]);

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockUpdateLastNotified).not.toHaveBeenCalled();
  });

  it("removes expired subscriptions on 410 and does not update lastNotified", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "expired-1",
      username: "alice",
    });
    mockGetActiveUsers.mockResolvedValueOnce([user] as never);
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([
        ["u1", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }],
      ]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    mockSendNotification.mockRejectedValueOnce(err as never);

    await push.notifyNewMails(["alice"]);

    expect(mockPgDeleteSubscription).toHaveBeenCalledTimes(1);
    expect(mockPgDeleteSubscription.mock.calls[0]).toEqual(["expired-1"] as never);
    expect(mockUpdateLastNotified).not.toHaveBeenCalled();
  });

  it("logs (without deleting) on non-410 send failures and does not update lastNotified", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mockGetActiveUsers.mockResolvedValueOnce([user] as never);
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([
        ["u1", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }],
      ]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    mockSendNotification.mockRejectedValueOnce(err as never);

    await push.notifyNewMails(["alice"]);

    expect(mockPgDeleteSubscription).not.toHaveBeenCalled();
    expect(mockUpdateLastNotified).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe("decrementBadgeCount", () => {
  beforeEach(resetAllMocks);

  it("sends a decrement payload for each subscription with a known badge count", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "sub-1",
      username: "alice",
    });
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([["u1", { count: 5 }]]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.decrementBadgeCount([user]);

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.badge_count).toBe(4);
    expect(payload.push_subscription_id).toBe("sub-1");
  });

  it("clamps decremented count at 0", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([["u1", { count: 0 }]]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.decrementBadgeCount([user]);

    const sendArgs = mockSendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.badge_count).toBe(0);
  });

  it("skips subscriptions with no notification entry", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "ghost" });
    mockGetUnreadNotifications.mockResolvedValueOnce(new Map() as never);
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);

    await push.decrementBadgeCount([user]);

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("removes expired subscriptions on 410", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "expired-2",
      username: "alice",
    });
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([["u1", { count: 2 }]]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    mockSendNotification.mockRejectedValueOnce(err as never);

    await push.decrementBadgeCount([user]);

    expect(mockPgDeleteSubscription).toHaveBeenCalledTimes(1);
    expect(mockPgDeleteSubscription.mock.calls[0]).toEqual(["expired-2"] as never);
  });

  it("logs (without deleting) on non-410 send failures", async () => {
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mockGetUnreadNotifications.mockResolvedValueOnce(
      new Map([["u1", { count: 2 }]]) as never
    );
    mockPgGetSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    mockSendNotification.mockRejectedValueOnce(err as never);

    await push.decrementBadgeCount([user]);

    expect(mockPgDeleteSubscription).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
