// Push notifications module — DI-shaped.
//
// All cross-module dependencies (web-push, the postgres repo, getActiveUsers,
// getNotifications, idleManager, logger, env) flow into `createPush(deps)`,
// which closes over them and returns the public API. This makes the module
// trivially unit-testable without `mock.module` of any kind: tests just call
// `createPush(mockDeps)` and exercise the returned functions.
//
// Background — earlier iterations of this module imported its dependencies
// directly. Per-file mocking via `mock.module(path, factory)` collided with
// other test files that mocked the same paths (Bun's `mock.module` is
// hoisted globally across the whole test run, not scoped per-file). The fix
// the Bun maintainers point at for this exact problem is dependency
// injection — that's what this is. No `*-deps.ts` indirection module, no
// shared `mock.module` preload, no setter-injection seam.
//
// Production code paths are unchanged: the named exports below come from a
// default `createPush` instance built from real imports + `process.env`.

import webPush, { PushSubscription } from "web-push";
import { SignedUser, ComputedPushSubscription } from "common";
import * as pushSubscriptionsRepo from "./postgres/repositories/push_subscriptions";
import { getActiveUsers as realGetActiveUsers } from "./users";
import { getNotifications as realGetNotifications } from "./mails/notifications";
import { idleManager as realIdleManager } from "./imap/idle-manager";
import { logger as realLogger } from "./logger";

export interface PushDeps {
  webPush: Pick<typeof webPush, "setVapidDetails" | "sendNotification">;
  repo: typeof pushSubscriptionsRepo;
  getActiveUsers: typeof realGetActiveUsers;
  getNotifications: typeof realGetNotifications;
  idleManager: { notifyNewMail: (usernames: string[], mailboxes?: string[]) => void };
  logger: Pick<typeof realLogger, "debug" | "info" | "warn" | "error">;
  // Accepts process.env directly (ProcessEnv is a string-keyed map with
  // optional values). Tests pass a hand-rolled subset.
  env: Record<string, string | undefined>;
}

export function createPush(deps: PushDeps) {
  let vapidPublicKey: string | undefined;
  let vapidConfigured = false;

  /**
   * Wires VAPID details into web-push from the env on `deps`. Called from
   * start.ts at boot. Kept out of factory-construction so test files can
   * exercise the not-configured branch by simply not calling initPush().
   */
  const initPush = (): void => {
    const { PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY, EMAIL_DOMAIN } = deps.env;
    const domainName = EMAIL_DOMAIN || "mydomain";
    vapidPublicKey = PUSH_VAPID_PUBLIC_KEY;
    vapidConfigured = !!(PUSH_VAPID_PUBLIC_KEY && PUSH_VAPID_PRIVATE_KEY);

    if (vapidConfigured) {
      deps.webPush.setVapidDetails(
        `mailto:admin@${domainName}`,
        PUSH_VAPID_PUBLIC_KEY!,
        PUSH_VAPID_PRIVATE_KEY!,
      );
    } else {
      deps.logger.warn("VAPID keys not configured - push notifications disabled", {
        component: "push",
        hint: "Set PUSH_VAPID_PUBLIC_KEY and PUSH_VAPID_PRIVATE_KEY to enable",
      });
    }
  };

  const getPushPublicKey = () => vapidPublicKey;
  const isPushEnabled = () => vapidConfigured;

  const storeSubscription = async (
    userId: string,
    push_subscription: PushSubscription,
  ) => {
    return deps.repo.storeSubscription(userId, push_subscription);
  };

  const deleteSubscription = (push_subscription_id: string) => {
    return deps.repo.deleteSubscription(push_subscription_id).catch((error) => {
      deps.logger.error(
        "Error deleting push subscription",
        { component: "push", push_subscription_id },
        error,
      );
    });
  };

  const ONE_DAY = 1000 * 60 * 60 * 24;

  const cleanSubscriptions = () => {
    setTimeout(async () => {
      deps.logger.info("Cleaning old push subscriptions", { component: "push" });
      const deleted = await deps.repo.cleanSubscriptions();
      deps.logger.info("Deleted old subscriptions", { component: "push", count: deleted });
      cleanSubscriptions();
    }, ONE_DAY);
  };

  const getSubscriptions = async (
    users: SignedUser[],
  ): Promise<ComputedPushSubscription[]> => {
    return deps.repo.getSubscriptions(users);
  };

  const refreshSubscription = async (id: string) => {
    return deps.repo.refreshSubscription(id);
  };

  const notifyNewMails = async (usernames: string[], mailboxes?: string[]) => {
    // Notify IDLE IMAP sessions immediately (works without VAPID)
    deps.idleManager.notifyNewMail(usernames, mailboxes);

    // Skip web push if VAPID not configured
    if (!vapidConfigured) return;

    const partialUsers = usernames.map((username) => ({ username }));
    const users = await deps.getActiveUsers(partialUsers);
    const [notifications, storedSubscriptions] = await Promise.all([
      deps.getNotifications(users),
      getSubscriptions(users),
    ]);

    return Promise.all(
      storedSubscriptions.map(async (subscription) => {
        const { push_subscription_id, username, lastNotified } = subscription;

        const notification = notifications.get(username);
        if (!notification) return;
        const badgeCount = notification.count || 0;
        const badgeLatest = notification.latest;
        const incrementedBadgeCount = badgeCount + 1;

        if (badgeLatest && badgeLatest <= lastNotified) return;

        const message =
          badgeCount > 1
            ? `You have ${incrementedBadgeCount} new mails`
            : "You have a new mail";

        const notificationPayload = {
          title: message,
          icon: "/icons/logo192.png",
          badge_count: incrementedBadgeCount,
          push_subscription_id,
        };

        let isFailed = false;

        await deps.webPush
          .sendNotification(subscription, JSON.stringify(notificationPayload))
          .catch(async (error) => {
            isFailed = true;
            if (error.statusCode === 410) {
              deps.logger.info("Subscription has expired, removing from database", {
                component: "push",
                push_subscription_id,
              });
              return deleteSubscription(push_subscription_id);
            } else {
              deps.logger.error(
                "Error sending push notification",
                { component: "push" },
                error,
              );
            }
          });

        if (isFailed) return;

        await deps.repo.updateLastNotified(push_subscription_id);

        return;
      }),
    );
  };

  const decrementBadgeCount = async (users: SignedUser[]) => {
    // Skip web push if VAPID not configured
    if (!vapidConfigured) return;

    const [notifications, storedSubscriptions] = await Promise.all([
      deps.getNotifications(users),
      getSubscriptions(users),
    ]);

    return Promise.all(
      storedSubscriptions.map((subscription) => {
        const { push_subscription_id, username } = subscription;

        const badgeCount = notifications.get(username)?.count;
        if (badgeCount === undefined) return;

        const decrementedBadgeCount = Math.max(badgeCount - 1, 0);

        const notificationPayload = {
          badge_count: decrementedBadgeCount,
          push_subscription_id,
        };

        return deps.webPush
          .sendNotification(subscription, JSON.stringify(notificationPayload))
          .catch((error) => {
            if (error.statusCode === 410) {
              deps.logger.info("Subscription has expired, removing from database", {
                component: "push",
                push_subscription_id,
              });
              deleteSubscription(push_subscription_id);
            } else {
              deps.logger.error(
                "Error sending push notification",
                { component: "push" },
                error,
              );
            }
          });
      }),
    );
  };

  return {
    initPush,
    getPushPublicKey,
    isPushEnabled,
    storeSubscription,
    deleteSubscription,
    cleanSubscriptions,
    getSubscriptions,
    refreshSubscription,
    notifyNewMails,
    decrementBadgeCount,
  };
}

// Default production instance — wires real imports + process.env.
const _push = createPush({
  webPush,
  repo: pushSubscriptionsRepo,
  getActiveUsers: realGetActiveUsers,
  getNotifications: realGetNotifications,
  idleManager: realIdleManager,
  logger: realLogger,
  env: process.env,
});

// Named exports preserve the existing public API so callers (lib/index.ts
// barrel, mails/receive.ts, start.ts) don't change.
export const initPush = _push.initPush;
export const getPushPublicKey = _push.getPushPublicKey;
export const isPushEnabled = _push.isPushEnabled;
export const storeSubscription = _push.storeSubscription;
export const deleteSubscription = _push.deleteSubscription;
export const cleanSubscriptions = _push.cleanSubscriptions;
export const getSubscriptions = _push.getSubscriptions;
export const refreshSubscription = _push.refreshSubscription;
export const notifyNewMails = _push.notifyNewMails;
export const decrementBadgeCount = _push.decrementBadgeCount;
