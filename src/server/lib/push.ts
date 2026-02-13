import webPush, { PushSubscription } from "web-push";
import { SignedUser, ComputedPushSubscription } from "common";
import {
  storeSubscription as pgStoreSubscription,
  deleteSubscription as pgDeleteSubscription,
  cleanSubscriptions as pgCleanSubscriptions,
  getSubscriptions as pgGetSubscriptions,
  refreshSubscription as pgRefreshSubscription,
  updateLastNotified,
} from "./postgres/repositories/push_subscriptions";
import { getUnreadNotifications } from "./postgres/repositories/mails";
import { getActiveUsers } from "./users";

// Import IDLE manager for real-time IMAP notifications
import { idleManager } from "./imap/idle-manager";

const domainName = process.env.EMAIL_DOMAIN || "mydomain";

const { PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY } = process.env;

const vapidKeys = {
  publicKey: PUSH_VAPID_PUBLIC_KEY || "",
  privateKey: PUSH_VAPID_PRIVATE_KEY || "",
};

webPush.setVapidDetails(
  `mailto:admin@${domainName}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

export const getPushPublicKey = () => PUSH_VAPID_PUBLIC_KEY;

export const storeSubscription = async (
  userId: string,
  push_subscription: PushSubscription
) => {
  return pgStoreSubscription(userId, push_subscription);
};

export const deleteSubscription = (push_subscription_id: string) => {
  return pgDeleteSubscription(push_subscription_id).catch(console.error);
};

const ONE_DAY = 1000 * 60 * 60 * 24;

export const cleanSubscriptions = () => {
  setTimeout(async () => {
    console.info("Cleaning old push subscriptions.");
    const deleted = await pgCleanSubscriptions();
    console.log(`Deleted ${deleted} old subscriptions`);
    cleanSubscriptions();
  }, ONE_DAY);
};

export const getSubscriptions = async (
  users: SignedUser[]
): Promise<ComputedPushSubscription[]> => {
  return pgGetSubscriptions(users);
};

export const refreshSubscription = async (id: string) => {
  return pgRefreshSubscription(id);
};

export const getNotifications = async (
  users: SignedUser[]
): Promise<Map<string, { count: number; latest?: Date }>> => {
  const userIds = users.map((u) => u.id);
  const rawNotifications = await getUnreadNotifications(userIds);

  // Convert to username-keyed map
  const notifications = new Map<string, { count: number; latest?: Date }>();
  for (const user of users) {
    const data = rawNotifications.get(user.id);
    if (data) {
      notifications.set(user.username, data);
    } else {
      notifications.set(user.username, { count: 0 });
    }
  }

  return notifications;
};

export const notifyNewMails = async (usernames: string[]) => {
  const partialUsers = usernames.map((username) => ({ username }));
  const users = await getActiveUsers(partialUsers);
  const [notifications, storedSubscriptions] = await Promise.all([
    getNotifications(users),
    getSubscriptions(users),
  ]);

  // Notify IDLE IMAP sessions immediately
  idleManager.notifyNewMail(usernames);

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

      await webPush
        .sendNotification(subscription, JSON.stringify(notificationPayload))
        .catch(async (error) => {
          isFailed = true;
          if (error.statusCode === 410) {
            console.log("Subscription has expired. Removing from database...");
            return deleteSubscription(push_subscription_id);
          } else {
            console.error("Error sending push notification:", error);
          }
        });

      if (isFailed) return;

      await updateLastNotified(push_subscription_id);

      return;
    })
  );
};

export const decrementBadgeCount = async (users: SignedUser[]) => {
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

      return webPush
        .sendNotification(subscription, JSON.stringify(notificationPayload))
        .catch((error) => {
          if (error.statusCode === 410) {
            console.log("Subscription has expired. Removing from database...");
            deleteSubscription(push_subscription_id);
          } else {
            console.error("Error sending push notification:", error);
          }
        });
    })
  );
};
