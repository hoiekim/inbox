import { describe, it, expect, mock } from "bun:test";
import type { PushSubscription } from "web-push";
import type { SignedUser, ComputedPushSubscription } from "common";
import { createPush } from "./push";

// Pure dependency injection. No `mock.module` calls in this file or any
// preload — bun maintainers' recommended workaround for the global
// `mock.module` hoisting problem is to make the unit-under-test take its
// dependencies as arguments.
//
// Each test builds fresh mock dependencies, instantiates a per-test `push`
// via `createPush(...)`, and asserts directly on the captured mock calls.

const TEST_VAPID_PUBLIC = "test-public-key-not-real";
const TEST_VAPID_PRIVATE = "test-private-key-not-real";

const makeMocks = (env: Record<string, string | undefined> = {
  EMAIL_DOMAIN: "test.com",
  PUSH_VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
  PUSH_VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
}) => {
  const setVapidDetails = mock(() => {});
  const sendNotification = mock(async () => ({ statusCode: 201 }));

  const repo = {
    storeSubscription: mock(async () => ({ _id: "sub-1" })),
    deleteSubscription: mock(async () => true),
    cleanSubscriptions: mock(async () => 0),
    getSubscriptions: mock(async () => [] as ComputedPushSubscription[]),
    refreshSubscription: mock(async () => true),
    updateLastNotified: mock(async () => {}),
  };

  const getActiveUsers = mock(async () => [] as SignedUser[]);
  const getNotifications = mock(
    async () => new Map() as Map<string, { count: number; latest?: Date }>,
  );
  const notifyNewMail = mock(() => {});

  const logger = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };

  const make = () =>
    createPush(
      { setVapidDetails, sendNotification } as never,
      repo as never,
      getActiveUsers as never,
      getNotifications as never,
      { notifyNewMail },
      logger,
      env,
    );

  return {
    make,
    setVapidDetails,
    sendNotification,
    repo,
    getActiveUsers,
    getNotifications,
    notifyNewMail,
    logger,
  };
};

const makeUser = (overrides: Partial<SignedUser> = {}): SignedUser =>
  ({
    id: "u1",
    username: "alice",
    ...overrides,
  }) as SignedUser;

const makeSubscription = (
  overrides: Partial<ComputedPushSubscription> = {},
): ComputedPushSubscription =>
  ({
    push_subscription_id: "sub-1",
    username: "alice",
    endpoint: "https://push.example.com/sub-1",
    keys: { p256dh: "p", auth: "a" },
    lastNotified: new Date(0),
    ...overrides,
  }) as ComputedPushSubscription;

describe("createPush — initPush", () => {
  it("calls webPush.setVapidDetails when both VAPID keys are set", () => {
    const m = makeMocks();
    const push = m.make();
    push.initPush();

    expect(m.setVapidDetails).toHaveBeenCalledTimes(1);
    const call = m.setVapidDetails.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe("mailto:admin@test.com");
    expect(call[1]).toBe(TEST_VAPID_PUBLIC);
    expect(call[2]).toBe(TEST_VAPID_PRIVATE);
  });

  it("warns and does not call setVapidDetails when keys are missing", () => {
    const m = makeMocks({ EMAIL_DOMAIN: "test.com" });
    const push = m.make();
    push.initPush();

    expect(m.setVapidDetails).not.toHaveBeenCalled();
    expect(m.logger.warn).toHaveBeenCalledTimes(1);
    expect(push.isPushEnabled()).toBe(false);
  });

  it("uses 'mydomain' fallback when EMAIL_DOMAIN is unset", () => {
    const m = makeMocks({
      PUSH_VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
      PUSH_VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
    });
    const push = m.make();
    push.initPush();

    const call = m.setVapidDetails.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe("mailto:admin@mydomain");
  });
});

describe("getPushPublicKey + isPushEnabled", () => {
  it("returns the configured VAPID public key + enabled=true after init", () => {
    const push = makeMocks().make();
    push.initPush();

    expect(push.getPushPublicKey()).toBe(TEST_VAPID_PUBLIC);
    expect(push.isPushEnabled()).toBe(true);
  });

  it("returns undefined + enabled=false before init", () => {
    const push = makeMocks().make();
    expect(push.getPushPublicKey()).toBeUndefined();
    expect(push.isPushEnabled()).toBe(false);
  });
});

describe("storeSubscription", () => {
  it("delegates to repository with the same arguments", async () => {
    const m = makeMocks();
    const push = m.make();
    const sub = {
      endpoint: "https://x",
      keys: { p256dh: "p", auth: "a" },
    } as PushSubscription;

    const result = await push.storeSubscription("user-1", sub);

    expect(m.repo.storeSubscription).toHaveBeenCalledTimes(1);
    expect(m.repo.storeSubscription.mock.calls[0]).toEqual(["user-1", sub] as never);
    expect(result).toEqual({ _id: "sub-1" } as never);
  });
});

describe("deleteSubscription", () => {
  it("delegates to repository and returns its result", async () => {
    const m = makeMocks();
    const push = m.make();

    const result = await push.deleteSubscription("sub-1");

    expect(m.repo.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(m.repo.deleteSubscription.mock.calls[0]).toEqual(["sub-1"] as never);
    expect(result).toBe(true as never);
  });

  it("logs and swallows errors from the repository", async () => {
    const m = makeMocks();
    const err = new Error("db down");
    m.repo.deleteSubscription.mockRejectedValueOnce(err as never);
    const push = m.make();

    const result = await push.deleteSubscription("sub-1");

    expect(result).toBeUndefined();
    expect(m.logger.error).toHaveBeenCalledTimes(1);
    const args = m.logger.error.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("Error deleting push subscription");
    expect(args[2]).toBe(err);
  });
});

describe("getSubscriptions", () => {
  it("delegates to repository with the user list", async () => {
    const m = makeMocks();
    const users = [makeUser()];
    const subs = [makeSubscription()];
    m.repo.getSubscriptions.mockResolvedValueOnce(subs as never);
    const push = m.make();

    const result = await push.getSubscriptions(users);

    expect(m.repo.getSubscriptions).toHaveBeenCalledTimes(1);
    expect(m.repo.getSubscriptions.mock.calls[0]).toEqual([users] as never);
    expect(result).toBe(subs as never);
  });
});

describe("refreshSubscription", () => {
  it("delegates to repository", async () => {
    const m = makeMocks();
    const push = m.make();

    await push.refreshSubscription("sub-1");

    expect(m.repo.refreshSubscription).toHaveBeenCalledTimes(1);
    expect(m.repo.refreshSubscription.mock.calls[0]).toEqual(["sub-1"] as never);
  });
});

describe("notifyNewMails", () => {
  it("notifies idleManager regardless of subscription state", async () => {
    const m = makeMocks();
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"], ["INBOX"]);

    expect(m.notifyNewMail).toHaveBeenCalledTimes(1);
    expect(m.notifyNewMail.mock.calls[0]).toEqual([["alice"], ["INBOX"]] as never);
  });

  it("notifies idleManager but skips web push when VAPID is not configured", async () => {
    const m = makeMocks({ EMAIL_DOMAIN: "test.com" });
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(m.notifyNewMail).toHaveBeenCalledTimes(1);
    expect(m.sendNotification).not.toHaveBeenCalled();
  });

  it("sends a push, then updates lastNotified, when there is fresh unread mail", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "sub-1",
      username: "alice",
      lastNotified: new Date("2026-05-04T00:00:00Z"),
    });
    m.getActiveUsers.mockResolvedValueOnce([user] as never);
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(m.sendNotification).toHaveBeenCalledTimes(1);
    const sendArgs = m.sendNotification.mock.calls[0] as unknown as unknown[];
    expect(sendArgs[0]).toBe(subscription);
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.title).toBe("You have a new mail");
    // `count: 1` already includes the just-arrived mail (saveMailHandler awaits
    // the insert before notifyNewMails runs), so the badge must equal the DB
    // count — no +1 (#471).
    expect(payload.badge_count).toBe(1);
    expect(payload.push_subscription_id).toBe("sub-1");
    expect(m.repo.updateLastNotified).toHaveBeenCalledTimes(1);
    expect(m.repo.updateLastNotified.mock.calls[0]).toEqual(["sub-1"] as never);
  });

  it("uses plural message when count > 1", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    m.getActiveUsers.mockResolvedValueOnce([user] as never);
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 4, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    const sendArgs = m.sendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    // Both message and badge reflect the actual unread count (4 in DB → 4 in
    // the message/badge), not 5 — see #471.
    expect(payload.title).toBe("You have 4 new mails");
    expect(payload.badge_count).toBe(4);
  });

  it("skips notification when no fresh unread mail (latest <= lastNotified)", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const same = new Date("2026-05-05T00:00:00Z");
    const subscription = makeSubscription({ username: "alice", lastNotified: same });
    m.getActiveUsers.mockResolvedValueOnce([user] as never);
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: same }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(m.sendNotification).not.toHaveBeenCalled();
    expect(m.repo.updateLastNotified).not.toHaveBeenCalled();
  });

  it("skips a subscription whose user has no notification entry", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "ghost" });
    m.getActiveUsers.mockResolvedValueOnce([user] as never);
    m.getNotifications.mockResolvedValueOnce(new Map() as never);
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(m.sendNotification).not.toHaveBeenCalled();
    expect(m.repo.updateLastNotified).not.toHaveBeenCalled();
  });

  it("removes expired subscriptions on 410 and does not update lastNotified", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "expired-1",
      username: "alice",
    });
    m.getActiveUsers.mockResolvedValueOnce([user] as never);
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    m.sendNotification.mockRejectedValueOnce(err as never);
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(m.repo.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(m.repo.deleteSubscription.mock.calls[0]).toEqual(["expired-1"] as never);
    expect(m.repo.updateLastNotified).not.toHaveBeenCalled();
  });

  it("logs (without deleting) on non-410 send failures and does not update lastNotified", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    m.getActiveUsers.mockResolvedValueOnce([user] as never);
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    m.sendNotification.mockRejectedValueOnce(err as never);
    const push = m.make();
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(m.repo.deleteSubscription).not.toHaveBeenCalled();
    expect(m.repo.updateLastNotified).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalled();
  });
});

describe("decrementBadgeCount", () => {
  it("skips entirely when VAPID is not configured", async () => {
    const m = makeMocks({ EMAIL_DOMAIN: "test.com" });
    const push = m.make();
    push.initPush();

    await push.decrementBadgeCount([makeUser()]);

    expect(m.repo.getSubscriptions).not.toHaveBeenCalled();
    expect(m.sendNotification).not.toHaveBeenCalled();
  });

  it("sends a decrement payload for each subscription with a known badge count", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "sub-1",
      username: "alice",
    });
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 5 }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(m.sendNotification).toHaveBeenCalledTimes(1);
    const sendArgs = m.sendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.badge_count).toBe(4);
    expect(payload.push_subscription_id).toBe("sub-1");
  });

  it("clamps decremented count at 0", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 0 }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.decrementBadgeCount([user]);

    const sendArgs = m.sendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.badge_count).toBe(0);
  });

  it("skips subscriptions with no notification entry", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "ghost" });
    m.getNotifications.mockResolvedValueOnce(new Map() as never);
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = m.make();
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(m.sendNotification).not.toHaveBeenCalled();
  });

  it("removes expired subscriptions on 410", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "expired-2",
      username: "alice",
    });
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 2 }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    m.sendNotification.mockRejectedValueOnce(err as never);
    const push = m.make();
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(m.repo.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(m.repo.deleteSubscription.mock.calls[0]).toEqual(["expired-2"] as never);
  });

  it("logs (without deleting) on non-410 send failures", async () => {
    const m = makeMocks();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    m.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 2 }]]) as never,
    );
    m.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    m.sendNotification.mockRejectedValueOnce(err as never);
    const push = m.make();
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(m.repo.deleteSubscription).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalled();
  });
});
