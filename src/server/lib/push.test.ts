import { describe, it, expect, mock, beforeEach, beforeAll } from "bun:test";
import type { PushSubscription } from "web-push";
import type { SignedUser, ComputedPushSubscription } from "common";

// ── Env setup (must run before push.ts evaluates) ────────────────────────────
// vapidConfigured is computed at module-init time in push.ts. Setting these
// here (top-level, before mock.module) guarantees they are present whenever
// push.ts is first evaluated within this Bun test run — including when another
// test file's transitive imports trigger the load before our beforeAll runs.
process.env.PUSH_VAPID_PUBLIC_KEY = "test-public-key";
process.env.PUSH_VAPID_PRIVATE_KEY = "test-private-key";
process.env.EMAIL_DOMAIN = "test.com";

// ── Mocks ────────────────────────────────────────────────────────────────────
//
// Bun's mock.module is hoisted, so these stubs are visible to push.ts at
// import time. push.ts is still loaded dynamically in beforeAll for clarity.

const mockSetVapidDetails = mock(() => {});
const mockSendNotification = mock(async () => ({ statusCode: 201 }));

mock.module("web-push", () => {
  const stub = {
    setVapidDetails: mockSetVapidDetails,
    sendNotification: mockSendNotification,
  };
  return { __esModule: true, default: stub, ...stub };
});

const mockPgStoreSubscription = mock(async () => ({ _id: "sub-1" }));
const mockPgDeleteSubscription = mock(async () => true);
const mockPgCleanSubscriptions = mock(async () => 0);
const mockPgGetSubscriptions = mock(async (): Promise<ComputedPushSubscription[]> => []);
const mockPgRefreshSubscription = mock(async () => true);
const mockUpdateLastNotified = mock(async () => {});

mock.module("./postgres/repositories/push_subscriptions", () => ({
  storeSubscription: mockPgStoreSubscription,
  deleteSubscription: mockPgDeleteSubscription,
  cleanSubscriptions: mockPgCleanSubscriptions,
  getSubscriptions: mockPgGetSubscriptions,
  refreshSubscription: mockPgRefreshSubscription,
  updateLastNotified: mockUpdateLastNotified,
}));

const mockGetUnreadNotifications = mock(
  async (): Promise<Map<string, { count: number; latest?: Date }>> => new Map()
);

// push.ts only needs getUnreadNotifications. Other entries are noop stubs to
// keep this mock from stripping exports that downstream test files rely on
// (e.g., mails.test.ts), since Bun's mock.module is global within a run.
mock.module("./postgres/repositories/mails", () => ({
  getUnreadNotifications: mockGetUnreadNotifications,
  saveMail: mock(async () => null),
  getMailByMessageId: mock(async () => null),
  getMailById: mock(async () => null),
  markMailRead: mock(async () => {}),
  markMailSaved: mock(async () => {}),
  deleteMail: mock(async () => {}),
  getMailHeaders: mock(async () => []),
  searchMails: mock(async () => []),
  getDomainUidNext: mock(async () => 1),
  getAccountUidNext: mock(async () => 1),
  getAccountStats: mock(async () => ({})),
  countMessages: mock(async () => 0),
  getMailsByRange: mock(async () => []),
  setMailFlags: mock(async () => null),
  searchMailsByUid: mock(async () => []),
  getAllUids: mock(async () => []),
  expungeDeletedMails: mock(async () => 0),
  getSpamMails: mock(async () => []),
  markMailSpam: mock(async () => false),
  copyMail: mock(async () => null),
}));

const mockGetActiveUsers = mock(async (): Promise<SignedUser[]> => []);

// push.ts only needs getActiveUsers. Other entries are noop stubs so this
// mock doesn't strip exports referenced by downstream test files.
mock.module("./users", () => ({
  getActiveUsers: mockGetActiveUsers,
  getSignedUser: mock(() => undefined),
  getUser: mock(async () => undefined),
  getUsers: mock(async () => []),
  expiryTimer: {},
  createToken: mock(async () => ({ id: "u1", username: "u", token: "tok" })),
  isValidEmail: (email: string) => {
    const values = email.split("@");
    if (values.length !== 2) return false;
    const [local, domain] = values;
    return (
      /^[a-zA-Z0-9._%+-]+$/.test(local) &&
      /^[a-zA-Z0-9.-]+$/.test(domain) &&
      domain.includes(".")
    );
  },
  startTimer: mock(() => {}),
  encryptPassword: mock(() => "hashed"),
  setUserInfo: mock(async () => null),
  createAuthenticationMail: mock(() => ({})),
}));

const mockNotifyNewMail = mock(() => {});

mock.module("./imap/idle-manager", () => ({
  idleManager: { notifyNewMail: mockNotifyNewMail },
}));

const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

// push.ts only needs `logger` from "server". Other entries are included so
// this mock doesn't strip exports that downstream test files import from
// "server" — Bun's mock.module is global within a test run.
mock.module("server", () => ({
  logger: mockLogger,
  getUser: mock(async () => null),
  setUserInfo: mock(async () => null),
  isValidEmail: (email: string) => {
    const values = email.split("@");
    if (values.length !== 2) return false;
    const [local, domain] = values;
    return (
      /^[a-zA-Z0-9._%+-]+$/.test(local) &&
      /^[a-zA-Z0-9.-]+$/.test(domain) &&
      domain.includes(".")
    );
  },
  createToken: mock(async () => ({ id: "u1", username: "u", token: "tok" })),
  getSignedUser: mock(() => null),
  createAuthenticationMail: mock(() => ({})),
  saveMailHandler: mock(async () => {}),
  sendMail: mock(async () => {}),
  startTimer: mock(() => {}),
  version: "0.0.0",
  getMailHeaders: mock(async () => []),
  getAccounts: mock(async () => ({ received: [], sent: [] })),
  getMailBody: mock(async () => null),
  deleteMail: mock(async () => {}),
  markRead: mock(async () => {}),
  markSaved: mock(async () => {}),
  decrementBadgeCount: mock(async () => {}),
  addressToUsername: mock((addr: string) => addr.split("@")[0]),
  searchMail: mock(async () => []),
  getSpamHeaders: mock(async () => []),
  getDomain: mock(() => "example.com"),
  getUserDomain: mock(() => "example.com"),
  getText: mock(() => ""),
  getClientIp: mock(() => "127.0.0.1"),
  getDomainUidNext: mock(async () => 1),
  getAccountUidNext: mock(async () => 1),
  getAllowlistForUser: mock(async () => []),
  addAllowlistEntry: mock(async () => null),
  removeAllowlistEntry: mock(async () => false),
  markSpam: mock(async () => false),
  getAttachment: mock(() => undefined),
  AUTH_ERROR_MESSAGE: "Authentication required",
  MailValidationError: class extends Error {},
  MailSendingError: class extends Error {},
  mailsTable: { queryOne: mock(async () => null) },
  SpamAllowlistModel: class {},
  pool: { query: mock(async () => ({ rows: [] })) },
  PostgresSessionStore: class {},
  getPushPublicKey: mock(() => "test-public-key"),
  storeSubscription: mock(async () => null),
  refreshSubscription: mock(async () => null),
}));

// The VAPID-unconfigured early-return in notifyNewMails / decrementBadgeCount
// is just `if (!vapidConfigured) return;` and is not covered here on purpose —
// re-mocking module-init state for one branch is more brittle than it's worth.

type PushModule = typeof import("./push");
let push: PushModule;

beforeAll(async () => {
  push = await import("./push");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  mockPgCleanSubscriptions.mockClear();
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("push module init", () => {
  it("calls webPush.setVapidDetails when both VAPID keys are set", () => {
    expect(mockSetVapidDetails).toHaveBeenCalled();
    const call = mockSetVapidDetails.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe("mailto:admin@test.com");
    expect(call[1]).toBe("test-public-key");
    expect(call[2]).toBe("test-private-key");
  });
});

describe("getPushPublicKey", () => {
  it("returns the public VAPID key from env", () => {
    expect(push.getPushPublicKey()).toBe("test-public-key");
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
