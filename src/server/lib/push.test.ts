import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { PushSubscription } from "web-push";
import type { SignedUser, ComputedPushSubscription } from "common";
import { createPush, type PushDeps } from "./push";

// Pure dependency injection. No `mock.module` calls in this file or any
// preload — bun maintainers' recommended workaround for the global
// `mock.module` hoisting problem is to make the unit-under-test take its
// dependencies as arguments. That's what `createPush(deps)` is for.
//
// Each test builds a fresh `deps` with mock functions, instantiates a
// per-test `push` instance via `createPush`, and asserts directly on the
// captured mock calls. No state leaks between files; no order sensitivity.

const TEST_VAPID_PUBLIC = "test-public-key-not-real";
const TEST_VAPID_PRIVATE = "test-private-key-not-real";

const makeMockDeps = () => {
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

  const deps = {
    webPush: { setVapidDetails, sendNotification },
    repo,
    getActiveUsers,
    getNotifications,
    idleManager: { notifyNewMail },
    logger,
    env: {
      EMAIL_DOMAIN: "test.com",
      PUSH_VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
      PUSH_VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
    },
  } as unknown as PushDeps;

  return { deps, mocks: { setVapidDetails, sendNotification, repo, getActiveUsers, getNotifications, notifyNewMail, logger } };
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
    const { deps, mocks } = makeMockDeps();
    const push = createPush(deps);
    push.initPush();

    expect(mocks.setVapidDetails).toHaveBeenCalledTimes(1);
    const call = mocks.setVapidDetails.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe("mailto:admin@test.com");
    expect(call[1]).toBe(TEST_VAPID_PUBLIC);
    expect(call[2]).toBe(TEST_VAPID_PRIVATE);
  });

  it("warns and does not call setVapidDetails when keys are missing", () => {
    const { deps, mocks } = makeMockDeps();
    deps.env = { EMAIL_DOMAIN: "test.com" };
    const push = createPush(deps);
    push.initPush();

    expect(mocks.setVapidDetails).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(push.isPushEnabled()).toBe(false);
  });

  it("uses 'mydomain' fallback when EMAIL_DOMAIN is unset", () => {
    const { deps, mocks } = makeMockDeps();
    deps.env = {
      PUSH_VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
      PUSH_VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
    };
    const push = createPush(deps);
    push.initPush();

    const call = mocks.setVapidDetails.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe("mailto:admin@mydomain");
  });
});

describe("getPushPublicKey + isPushEnabled", () => {
  it("returns the configured VAPID public key + enabled=true after init", () => {
    const { deps } = makeMockDeps();
    const push = createPush(deps);
    push.initPush();

    expect(push.getPushPublicKey()).toBe(TEST_VAPID_PUBLIC);
    expect(push.isPushEnabled()).toBe(true);
  });

  it("returns undefined + enabled=false before init", () => {
    const { deps } = makeMockDeps();
    const push = createPush(deps);
    expect(push.getPushPublicKey()).toBeUndefined();
    expect(push.isPushEnabled()).toBe(false);
  });
});

describe("storeSubscription", () => {
  it("delegates to repository with the same arguments", async () => {
    const { deps, mocks } = makeMockDeps();
    const push = createPush(deps);
    const sub = {
      endpoint: "https://x",
      keys: { p256dh: "p", auth: "a" },
    } as PushSubscription;

    const result = await push.storeSubscription("user-1", sub);

    expect(mocks.repo.storeSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.repo.storeSubscription.mock.calls[0]).toEqual(["user-1", sub] as never);
    expect(result).toEqual({ _id: "sub-1" } as never);
  });
});

describe("deleteSubscription", () => {
  it("delegates to repository and returns its result", async () => {
    const { deps, mocks } = makeMockDeps();
    const push = createPush(deps);

    const result = await push.deleteSubscription("sub-1");

    expect(mocks.repo.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.repo.deleteSubscription.mock.calls[0]).toEqual(["sub-1"] as never);
    expect(result).toBe(true as never);
  });

  it("logs and swallows errors from the repository", async () => {
    const { deps, mocks } = makeMockDeps();
    const err = new Error("db down");
    mocks.repo.deleteSubscription.mockRejectedValueOnce(err as never);
    const push = createPush(deps);

    const result = await push.deleteSubscription("sub-1");

    expect(result).toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    const args = mocks.logger.error.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("Error deleting push subscription");
    expect(args[2]).toBe(err);
  });
});

describe("getSubscriptions", () => {
  it("delegates to repository with the user list", async () => {
    const { deps, mocks } = makeMockDeps();
    const users = [makeUser()];
    const subs = [makeSubscription()];
    mocks.repo.getSubscriptions.mockResolvedValueOnce(subs as never);
    const push = createPush(deps);

    const result = await push.getSubscriptions(users);

    expect(mocks.repo.getSubscriptions).toHaveBeenCalledTimes(1);
    expect(mocks.repo.getSubscriptions.mock.calls[0]).toEqual([users] as never);
    expect(result).toBe(subs as never);
  });
});

describe("refreshSubscription", () => {
  it("delegates to repository", async () => {
    const { deps, mocks } = makeMockDeps();
    const push = createPush(deps);

    await push.refreshSubscription("sub-1");

    expect(mocks.repo.refreshSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.repo.refreshSubscription.mock.calls[0]).toEqual(["sub-1"] as never);
  });
});

describe("notifyNewMails", () => {
  it("notifies idleManager regardless of subscription state", async () => {
    const { deps, mocks } = makeMockDeps();
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"], ["INBOX"]);

    expect(mocks.notifyNewMail).toHaveBeenCalledTimes(1);
    expect(mocks.notifyNewMail.mock.calls[0]).toEqual([["alice"], ["INBOX"]] as never);
  });

  it("notifies idleManager but skips web push when VAPID is not configured", async () => {
    const { deps, mocks } = makeMockDeps();
    deps.env = { EMAIL_DOMAIN: "test.com" }; // no VAPID
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(mocks.notifyNewMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("sends a push, then updates lastNotified, when there is fresh unread mail", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "sub-1",
      username: "alice",
      lastNotified: new Date("2026-05-04T00:00:00Z"),
    });
    mocks.getActiveUsers.mockResolvedValueOnce([user] as never);
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const sendArgs = mocks.sendNotification.mock.calls[0] as unknown as unknown[];
    expect(sendArgs[0]).toBe(subscription);
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.title).toBe("You have a new mail");
    expect(payload.badge_count).toBe(2);
    expect(payload.push_subscription_id).toBe("sub-1");
    expect(mocks.repo.updateLastNotified).toHaveBeenCalledTimes(1);
    expect(mocks.repo.updateLastNotified.mock.calls[0]).toEqual(["sub-1"] as never);
  });

  it("uses plural message when count > 1", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mocks.getActiveUsers.mockResolvedValueOnce([user] as never);
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 4, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    const sendArgs = mocks.sendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.title).toBe("You have 5 new mails");
    expect(payload.badge_count).toBe(5);
  });

  it("skips notification when no fresh unread mail (latest <= lastNotified)", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const same = new Date("2026-05-05T00:00:00Z");
    const subscription = makeSubscription({ username: "alice", lastNotified: same });
    mocks.getActiveUsers.mockResolvedValueOnce([user] as never);
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: same }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.repo.updateLastNotified).not.toHaveBeenCalled();
  });

  it("skips a subscription whose user has no notification entry", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "ghost" });
    mocks.getActiveUsers.mockResolvedValueOnce([user] as never);
    mocks.getNotifications.mockResolvedValueOnce(new Map() as never);
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.repo.updateLastNotified).not.toHaveBeenCalled();
  });

  it("removes expired subscriptions on 410 and does not update lastNotified", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "expired-1",
      username: "alice",
    });
    mocks.getActiveUsers.mockResolvedValueOnce([user] as never);
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    mocks.sendNotification.mockRejectedValueOnce(err as never);
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(mocks.repo.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.repo.deleteSubscription.mock.calls[0]).toEqual(["expired-1"] as never);
    expect(mocks.repo.updateLastNotified).not.toHaveBeenCalled();
  });

  it("logs (without deleting) on non-410 send failures and does not update lastNotified", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mocks.getActiveUsers.mockResolvedValueOnce([user] as never);
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 1, latest: new Date("2026-05-05T00:00:00Z") }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    mocks.sendNotification.mockRejectedValueOnce(err as never);
    const push = createPush(deps);
    push.initPush();

    await push.notifyNewMails(["alice"]);

    expect(mocks.repo.deleteSubscription).not.toHaveBeenCalled();
    expect(mocks.repo.updateLastNotified).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});

describe("decrementBadgeCount", () => {
  it("skips entirely when VAPID is not configured", async () => {
    const { deps, mocks } = makeMockDeps();
    deps.env = { EMAIL_DOMAIN: "test.com" };
    const push = createPush(deps);
    push.initPush();

    await push.decrementBadgeCount([makeUser()]);

    expect(mocks.repo.getSubscriptions).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("sends a decrement payload for each subscription with a known badge count", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "sub-1",
      username: "alice",
    });
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 5 }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const sendArgs = mocks.sendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.badge_count).toBe(4);
    expect(payload.push_subscription_id).toBe("sub-1");
  });

  it("clamps decremented count at 0", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 0 }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.decrementBadgeCount([user]);

    const sendArgs = mocks.sendNotification.mock.calls[0] as unknown as unknown[];
    const payload = JSON.parse(sendArgs[1] as string);
    expect(payload.badge_count).toBe(0);
  });

  it("skips subscriptions with no notification entry", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "ghost" });
    mocks.getNotifications.mockResolvedValueOnce(new Map() as never);
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const push = createPush(deps);
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("removes expired subscriptions on 410", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({
      push_subscription_id: "expired-2",
      username: "alice",
    });
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 2 }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    mocks.sendNotification.mockRejectedValueOnce(err as never);
    const push = createPush(deps);
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(mocks.repo.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.repo.deleteSubscription.mock.calls[0]).toEqual(["expired-2"] as never);
  });

  it("logs (without deleting) on non-410 send failures", async () => {
    const { deps, mocks } = makeMockDeps();
    const user = makeUser({ id: "u1", username: "alice" });
    const subscription = makeSubscription({ username: "alice" });
    mocks.getNotifications.mockResolvedValueOnce(
      new Map([["alice", { count: 2 }]]) as never,
    );
    mocks.repo.getSubscriptions.mockResolvedValueOnce([subscription] as never);
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    mocks.sendNotification.mockRejectedValueOnce(err as never);
    const push = createPush(deps);
    push.initPush();

    await push.decrementBadgeCount([user]);

    expect(mocks.repo.deleteSubscription).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});
