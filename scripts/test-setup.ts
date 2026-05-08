// Bun test preload — runs before any test file is parsed.
//
// Two responsibilities:
//   1. Default env vars module-init code reads at import time (VAPID
//      keys for push.ts). We use a real, generated VAPID pair so
//      web-push's setVapidDetails (called at startup) doesn't throw on
//      decode-length validation, even when push.ts loads before the
//      test mocks register.
//   2. Global module mocks for *external* libraries and *internal*
//      modules that no other test file mocks. Registering these here
//      sidesteps Bun's mock-load-order trap: `mock.module(...)` is
//      hoisted globally across the whole test run, so per-file calls
//      lose to whichever file's hoist happens last. The mocks below
//      don't conflict with any per-file mock.module call (verified via
//      grep across `src/**/*.test.ts`), so global registration is safe.
//
// Mocks for shared modules with legitimate per-test variation
// (`./postgres/repositories/mails`, `./users`, `server`) deliberately
// stay out of this file — those are still injected per-test through
// `setPushDependencies(...)` because globalising them here would
// silently override the per-file mocks declared in `mails/*.test.ts`,
// `users.test.ts`, etc.

import { mock } from "bun:test";
import path from "path";

const LIB_DIR = path.resolve(import.meta.dir, "../src/server/lib");

// Hardcoded test VAPID pair (NIST P-256, 65-byte uncompressed public key
// + 32-byte private). Generated once with web-push.generateVAPIDKeys()
// and pinned here so we don't have to import the real web-push *before*
// registering the mock.module factory below.
const TEST_VAPID_PUBLIC =
  "BEi8Z6Wc1LwXhwK13rlsWyNULg6w_3w0klfTLF8SDfoqpiZbIpmnW6BtUCcYFsxF1eg5Y3LZQ97aNzkPGTxqPWA";
const TEST_VAPID_PRIVATE = "ud-mxk5ENwBKVjOjMYDTCMP6dmnJfXLyTgvD9_uM7uA";

// Use ||= so empty-string values left in the env by some invocation
// contexts (e.g. cron shells) get the test default.
process.env.PUSH_VAPID_PUBLIC_KEY ||= TEST_VAPID_PUBLIC;
process.env.PUSH_VAPID_PRIVATE_KEY ||= TEST_VAPID_PRIVATE;
// EMAIL_DOMAIN is force-overridden so push.ts produces a deterministic
// "mailto:admin@test.com" identifier regardless of whatever inbox/cron
// shell vars happen to be present.
process.env.EMAIL_DOMAIN = "test.com";

// ── Mock spies (exported so test files can assert against them) ─────────────
//
// These are real mock() functions; push.test.ts imports them and chains
// mockResolvedValueOnce / reads .mock.calls. The same instances are
// referenced by the mock.module factories below, so behaviour mutated
// in a test propagates into whatever code path reaches the mocked module.

export const webPushSpies = {
  setVapidDetails: mock(() => {}),
  sendNotification: mock(async () => ({ statusCode: 201 })),
  generateVAPIDKeys: () => ({
    publicKey: TEST_VAPID_PUBLIC,
    privateKey: TEST_VAPID_PRIVATE,
  }),
};

export const idleManagerSpies = {
  notifyNewMail: mock(() => {}),
};

export const pushSubscriptionSpies = {
  storeSubscription: mock(async () => ({ _id: "sub-1" })),
  deleteSubscription: mock(async () => true),
  cleanSubscriptions: mock(async () => 0),
  getSubscriptions: mock(async () => [] as unknown[]),
  refreshSubscription: mock(async () => true),
  updateLastNotified: mock(async () => {}),
};

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module("web-push", () => ({
  default: {
    setVapidDetails: webPushSpies.setVapidDetails,
    sendNotification: webPushSpies.sendNotification,
    generateVAPIDKeys: webPushSpies.generateVAPIDKeys,
  },
  setVapidDetails: webPushSpies.setVapidDetails,
  sendNotification: webPushSpies.sendNotification,
  generateVAPIDKeys: webPushSpies.generateVAPIDKeys,
}));

mock.module(path.join(LIB_DIR, "imap/idle-manager"), () => ({
  idleManager: { notifyNewMail: idleManagerSpies.notifyNewMail },
}));

mock.module(path.join(LIB_DIR, "postgres/repositories/push_subscriptions"), () => ({
  storeSubscription: pushSubscriptionSpies.storeSubscription,
  deleteSubscription: pushSubscriptionSpies.deleteSubscription,
  cleanSubscriptions: pushSubscriptionSpies.cleanSubscriptions,
  getSubscriptions: pushSubscriptionSpies.getSubscriptions,
  refreshSubscription: pushSubscriptionSpies.refreshSubscription,
  updateLastNotified: pushSubscriptionSpies.updateLastNotified,
}));
