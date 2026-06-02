// Push notifications module — DI-shaped.
//
// All cross-module dependencies (web-push, the postgres repo, getActiveUsers,
// getNotifications, idleManager, logger, env) are passed positionally to
// `createPush(...)`, which closes over them and returns the public API as a
// single object. Tests construct their own instance with mock dependencies;
// production gets the default `push` instance below.

import webPush, { PushSubscription } from "web-push";
import { SignedUser, ComputedPushSubscription } from "common";
import * as pushSubscriptionsRepo from "./postgres/repositories/push_subscriptions";
import { getActiveUsers as realGetActiveUsers } from "./users";
import { getNotifications as realGetNotifications } from "./mails/notifications";
import { idleManager as realIdleManager } from "./imap/idle-manager";
import { logger as realLogger } from "./logger";

type WebPush = Pick<typeof webPush, "setVapidDetails" | "sendNotification">;
type Repo = typeof pushSubscriptionsRepo;
type GetActiveUsers = typeof realGetActiveUsers;
type GetNotifications = typeof realGetNotifications;
type IdleManager = { notifyNewMail: (usernames: string[], mailboxes?: string[]) => void };
type Logger = Pick<typeof realLogger, "debug" | "info" | "warn" | "error">;
type Env = Record<string, string | undefined>;

export const createPush = (
  webPushImpl: WebPush,
  repo: Repo,
  getActiveUsers: GetActiveUsers,
  getNotifications: GetNotifications,
  idleManager: IdleManager,
  logger: Logger,
  env: Env,
) => {
  let vapidPublicKey: string | undefined;
  let vapidConfigured = false;

  const initPush = (): void => {
    const { PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY, EMAIL_DOMAIN } = env;
    const domainName = EMAIL_DOMAIN || "mydomain";
    vapidPublicKey = PUSH_VAPID_PUBLIC_KEY;
    vapidConfigured = !!(PUSH_VAPID_PUBLIC_KEY && PUSH_VAPID_PRIVATE_KEY);

    if (vapidConfigured) {
      webPushImpl.setVapidDetails(
        `mailto:admin@${domainName}`,
        PUSH_VAPID_PUBLIC_KEY!,
        PUSH_VAPID_PRIVATE_KEY!,
      );
    } else {
      logger.warn("VAPID keys not configured - push notifications disabled", {
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
    return repo.storeSubscription(userId, push_subscription);
  };

  const deleteSubscription = (push_subscription_id: string) => {
    return repo.deleteSubscription(push_subscription_id).catch((error) => {
      logger.error(
        "Error deleting push subscription",
        { component: "push", push_subscription_id },
        error,
      );
    });
  };

  // Send one notification and absorb the "subscription expired" (HTTP 410)
  // case by deleting the dead subscription. Returns whether the send
  // succeeded so callers can gate follow-up writes (e.g. updateLastNotified)
  // without threading a mutable flag out of a .catch.
  const sendNotificationSafely = async (
    subscription: ComputedPushSubscription,
    payload: object,
    push_subscription_id: string,
  ): Promise<boolean> => {
    try {
      await webPushImpl.sendNotification(subscription, JSON.stringify(payload));
      return true;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 410) {
        logger.info("Subscription has expired, removing from database", {
          component: "push",
          push_subscription_id,
        });
        await deleteSubscription(push_subscription_id);
      } else {
        logger.error(
          "Error sending push notification",
          { component: "push" },
          error,
        );
      }
      return false;
    }
  };

  const ONE_DAY = 1000 * 60 * 60 * 24;

  const cleanSubscriptions = () => {
    setTimeout(async () => {
      logger.info("Cleaning old push subscriptions", { component: "push" });
      const deleted = await repo.cleanSubscriptions();
      logger.info("Deleted old subscriptions", { component: "push", count: deleted });
      cleanSubscriptions();
    }, ONE_DAY);
  };

  const getSubscriptions = async (
    users: SignedUser[],
  ): Promise<ComputedPushSubscription[]> => {
    return repo.getSubscriptions(users);
  };

  const refreshSubscription = async (id: string) => {
    return repo.refreshSubscription(id);
  };

  const notifyNewMails = async (usernames: string[], mailboxes?: string[]) => {
    idleManager.notifyNewMail(usernames, mailboxes);

    if (!vapidConfigured) return;

    const partialUsers = usernames.map((username) => ({ username }));
    const users = await getActiveUsers(partialUsers);
    const [notifications, storedSubscriptions] = await Promise.all([
      getNotifications(users),
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

        const success = await sendNotificationSafely(
          subscription,
          notificationPayload,
          push_subscription_id,
        );
        if (!success) return;

        await repo.updateLastNotified(push_subscription_id);

        return;
      }),
    );
  };

  const decrementBadgeCount = async (users: SignedUser[]) => {
    if (!vapidConfigured) return;

    const [notifications, storedSubscriptions] = await Promise.all([
      getNotifications(users),
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

        return sendNotificationSafely(
          subscription,
          notificationPayload,
          push_subscription_id,
        );
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
};

export const push = createPush(
  webPush,
  pushSubscriptionsRepo,
  realGetActiveUsers,
  realGetNotifications,
  realIdleManager,
  realLogger,
  process.env,
);
