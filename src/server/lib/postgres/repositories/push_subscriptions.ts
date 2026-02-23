import crypto from "crypto";
import { PushSubscription } from "web-push";
import { pool } from "../client";
import {
  pushSubscriptionsTable,
  PUSH_SUBSCRIPTION_ID,
  USER_ID,
  ENDPOINT,
  KEYS_P256DH,
  KEYS_AUTH,
  LAST_NOTIFIED,
} from "../models";
import { ComputedPushSubscription, SignedUser } from "common";

/**
 * Stores a push subscription for a user
 * @param userId
 * @param push_subscription
 * @returns The created subscription ID
 */
export const storeSubscription = async (
  userId: string,
  push_subscription: PushSubscription
): Promise<{ _id: string } | undefined> => {
  try {
    const push_subscription_id = crypto.randomUUID();
    const data = {
      [PUSH_SUBSCRIPTION_ID]: push_subscription_id,
      [USER_ID]: userId,
      [ENDPOINT]: push_subscription.endpoint,
      [KEYS_P256DH]: push_subscription.keys.p256dh,
      [KEYS_AUTH]: push_subscription.keys.auth,
      [LAST_NOTIFIED]: new Date().toISOString(),
    };

    const result = await pushSubscriptionsTable.insert(data, [
      PUSH_SUBSCRIPTION_ID,
    ]);
    if (result) return { _id: result.push_subscription_id as string };
    return undefined;
  } catch (error) {
    console.error("Failed to store push subscription:", error);
    return undefined;
  }
};

/**
 * Deletes a push subscription by ID
 * @param push_subscription_id
 * @returns Success boolean
 */
export const deleteSubscription = async (
  push_subscription_id: string
): Promise<boolean> => {
  try {
    return await pushSubscriptionsTable.hardDelete(push_subscription_id);
  } catch (error) {
    console.error("Failed to delete push subscription:", error);
    return false;
  }
};

/**
 * Cleans old push subscriptions (older than 7 days)
 */
export const cleanSubscriptions = async (): Promise<number> => {
  try {
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const sql = `
      DELETE FROM push_subscriptions 
      WHERE updated < $1
      RETURNING push_subscription_id
    `;
    const result = await pool.query(sql, [cutoffDate]);
    return result.rowCount ?? 0;
  } catch (error) {
    console.error("Failed to clean push subscriptions:", error);
    return 0;
  }
};

/**
 * Gets all push subscriptions for given users
 * @param users
 * @returns Array of computed push subscriptions
 */
export const getSubscriptions = async (
  users: SignedUser[]
): Promise<ComputedPushSubscription[]> => {
  try {
    if (users.length === 0) return [];

    const userIds = users.map((u) => u.id);
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");

    const sql = `
      SELECT * FROM push_subscriptions 
      WHERE user_id IN (${placeholders})
    `;

    const result = await pool.query(sql, userIds);

    const userMap = new Map(users.map((u) => [u.id, u]));

    return result.rows
      .map((row: Record<string, unknown>): ComputedPushSubscription | null => {
        const user = userMap.get(row.user_id as string);
        if (!user) return null;

        return {
          endpoint: row.endpoint as string,
          keys: {
            p256dh: row.keys_p256dh as string,
            auth: row.keys_auth as string,
          },
          push_subscription_id: row.push_subscription_id as string,
          username: user.username,
          lastNotified: new Date(row.last_notified as string),
          updated: new Date(row.updated as string),
        };
      })
      .filter((s): s is ComputedPushSubscription => s !== null);
  } catch (error) {
    console.error("Failed to get push subscriptions:", error);
    return [];
  }
};

/**
 * Refreshes a subscription's updated timestamp
 * @param push_subscription_id
 * @returns Success boolean
 */
export const refreshSubscription = async (
  push_subscription_id: string
): Promise<boolean> => {
  try {
    const result = await pushSubscriptionsTable.update(push_subscription_id, {});
    return result !== null;
  } catch (error) {
    console.error("Failed to refresh push subscription:", error);
    return false;
  }
};

/**
 * Updates the lastNotified timestamp for a subscription
 * @param push_subscription_id
 * @returns Success boolean
 */
export const updateLastNotified = async (
  push_subscription_id: string
): Promise<boolean> => {
  try {
    const result = await pushSubscriptionsTable.update(push_subscription_id, {
      [LAST_NOTIFIED]: new Date().toISOString(),
    });
    return result !== null;
  } catch (error) {
    console.error("Failed to update last notified:", error);
    return false;
  }
};
