import webPush, { PushSubscription } from "web-push";
import { elasticsearchClient, index, getNotifications } from "server";
import { domainName } from ".";

const { PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY } = process.env;

const vapidKeys = {
  publicKey: PUSH_VAPID_PUBLIC_KEY || "",
  privateKey: PUSH_VAPID_PRIVATE_KEY || ""
};

webPush.setVapidDetails(
  `mailto:admin@${domainName}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

export const storeSubscription = async (
  username: string,
  push_subscription: PushSubscription
) => {
  const response = await elasticsearchClient.index({
    index,
    document: {
      type: "push_subscription",
      user: { username },
      push_subscription,
      updated: new Date()
    }
  });

  return response;
};

export const deleteSubscription = (push_subscription_id: string) => {
  return elasticsearchClient
    .deleteByQuery({
      index,
      query: {
        bool: {
          must: [
            { term: { _id: push_subscription_id } },
            { term: { type: "push_subscription" } }
          ]
        }
      }
    })
    .catch(console.error);
};

const ONE_DAY = 1000 * 60 * 60 * 24;

export const cleanSubscriptions = () => {
  elasticsearchClient
    .deleteByQuery({
      index,
      query: {
        bool: {
          must: [
            { range: { updated: { lt: "now-7d" } } },
            { term: { type: "push_subscription" } }
          ]
        }
      }
    })
    .catch(console.error);
  setTimeout(cleanSubscriptions, ONE_DAY);
};

export type StoredPushSubscription = {
  username: string;
  push_subscription_id: string;
  updated: Date;
} & PushSubscription;

export const getSubscriptions = async (
  usernames: string[]
): Promise<StoredPushSubscription[]> => {
  const matchUsername = usernames.map((username) => {
    return { term: { "user.username": username } };
  });

  const response = await elasticsearchClient.search<{
    type: string;
    user?: { username: string };
    push_subscription?: PushSubscription;
    updated?: string;
  }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { type: "push_subscription" } },
          { bool: { should: matchUsername } }
        ]
      }
    }
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      const push_subscription_id = e._id;
      if (!source) return;
      const { push_subscription, updated } = source;
      if (!push_subscription) return;
      const username = source.user?.username;
      if (!username) return;
      return {
        ...push_subscription,
        push_subscription_id,
        username,
        updated: updated ? new Date(updated) : new Date()
      };
    })
    .filter((e) => e) as StoredPushSubscription[];
};

export const refreshSubscription = async (id: string) => {
  const updated = new Date().toISOString();
  const response = await elasticsearchClient.updateByQuery({
    index,
    query: {
      bool: {
        filter: [{ term: { type: "push_subscription" } }, { term: { _id: id } }]
      }
    },
    script: { source: `ctx._source['updated'] = '${updated}'` }
  });
  return response;
};

export const notifyNewMails = async (usernames: string[]) => {
  const [notifications, storedSubscriptions] = await Promise.all([
    getNotifications(usernames),
    getSubscriptions(usernames)
  ]);

  return Promise.all(
    storedSubscriptions.map((subscription) => {
      const { push_subscription_id, username } = subscription;

      const badge_count = notifications.get(username);
      if (badge_count === undefined) return;

      const incrementedBadgeCount = badge_count + 1;

      const message =
        badge_count > 1
          ? `You have ${incrementedBadgeCount} new mails`
          : "You have a new mail";

      const notificationPayload = {
        title: message,
        icon: "/icons/logo192.png",
        badge_count: incrementedBadgeCount,
        push_subscription_id
      };

      return webPush
        .sendNotification(subscription, JSON.stringify(notificationPayload))
        .catch((error) => {
          if (error.statusCode === 410) {
            console.log("Subscription has expired. Removing from database...");
            try {
              deleteSubscription(push_subscription_id);
            } catch (err: any) {
              console.error(err);
            }
          } else {
            console.error("Error sending push notification:", error);
          }
        });
    })
  );
};

export const decrementBadgeCount = async (usernames: string[]) => {
  const [notifications, storedSubscriptions] = await Promise.all([
    getNotifications(usernames),
    getSubscriptions(usernames)
  ]);

  return Promise.all(
    storedSubscriptions.map((subscription) => {
      const { push_subscription_id, username } = subscription;

      const badge_count = notifications.get(username);
      if (badge_count === undefined) return;

      const decrementedBadgeCount = Math.max(badge_count - 1, 0);

      const notificationPayload = {
        badge_count: decrementedBadgeCount,
        push_subscription_id
      };

      return webPush
        .sendNotification(subscription, JSON.stringify(notificationPayload))
        .catch((error) => {
          if (error.statusCode === 410) {
            console.log("Subscription has expired. Removing from database...");
            try {
              deleteSubscription(push_subscription_id);
            } catch (err: any) {
              console.error(err);
            }
          } else {
            console.error("Error sending push notification:", error);
          }
        });
    })
  );
};
