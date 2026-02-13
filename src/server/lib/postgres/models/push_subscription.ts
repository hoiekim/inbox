import {
  PUSH_SUBSCRIPTION_ID,
  USER_ID,
  ENDPOINT,
  KEYS_P256DH,
  KEYS_AUTH,
  LAST_NOTIFIED,
  UPDATED,
  PUSH_SUBSCRIPTIONS,
} from "./common";
import { Schema, Model, createTable } from "./base";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

export interface PushSubscriptionJSON {
  push_subscription_id: string;
  user_id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  last_notified: string | null;
}

const pushSubscriptionSchema = {
  [PUSH_SUBSCRIPTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [ENDPOINT]: "TEXT NOT NULL",
  [KEYS_P256DH]: "TEXT NOT NULL",
  [KEYS_AUTH]: "TEXT NOT NULL",
  [LAST_NOTIFIED]: "TIMESTAMPTZ",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type PushSubscriptionSchema = typeof pushSubscriptionSchema;

export class PushSubscriptionModel extends Model<PushSubscriptionJSON, PushSubscriptionSchema> {
  declare push_subscription_id: string;
  declare user_id: string;
  declare endpoint: string;
  declare keys_p256dh: string;
  declare keys_auth: string;
  declare last_notified: string | null;
  declare updated: string;

  static typeChecker = {
    push_subscription_id: isString,
    user_id: isString,
    endpoint: isString,
    keys_p256dh: isString,
    keys_auth: isString,
    last_notified: isNullableString,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, PushSubscriptionModel.typeChecker);
  }

  toJSON(): PushSubscriptionJSON {
    return {
      push_subscription_id: this.push_subscription_id,
      user_id: this.user_id,
      endpoint: this.endpoint,
      keys_p256dh: this.keys_p256dh,
      keys_auth: this.keys_auth,
      last_notified: this.last_notified,
    };
  }
}

export const pushSubscriptionsTable = createTable({
  name: PUSH_SUBSCRIPTIONS,
  primaryKey: PUSH_SUBSCRIPTION_ID,
  schema: pushSubscriptionSchema,
  ModelClass: PushSubscriptionModel,
  supportsSoftDelete: false,
  indexes: [{ column: USER_ID }],
});

export const pushSubscriptionColumns = Object.keys(pushSubscriptionsTable.schema);
