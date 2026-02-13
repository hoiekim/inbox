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
import {
  Schema,
  AssertTypeFn,
  createAssertType,
  Model,
  createTable,
} from "./base";

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

export class PushSubscriptionModel extends Model<PushSubscriptionJSON> {
  push_subscription_id!: string;
  user_id!: string;
  endpoint!: string;
  keys_p256dh!: string;
  keys_auth!: string;
  last_notified!: string | null;
  updated!: string;

  static typeChecker = {
    push_subscription_id: isString,
    user_id: isString,
    endpoint: isString,
    keys_p256dh: isString,
    keys_auth: isString,
    last_notified: isNullableString,
    updated: isNullableString,
  };

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType(
    "PushSubscriptionModel",
    PushSubscriptionModel.typeChecker
  );

  constructor(data: unknown) {
    super();
    PushSubscriptionModel.assertType(data);
    const r = data as Record<string, unknown>;
    Object.keys(PushSubscriptionModel.typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = r[k];
    });
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
  schema: {
    [PUSH_SUBSCRIPTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
    [ENDPOINT]: "TEXT NOT NULL",
    [KEYS_P256DH]: "TEXT NOT NULL",
    [KEYS_AUTH]: "TEXT NOT NULL",
    [LAST_NOTIFIED]: "TIMESTAMPTZ",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  } as Schema<Record<string, unknown>>,
  ModelClass: PushSubscriptionModel,
  supportsSoftDelete: false,
  indexes: [{ column: USER_ID }],
});

export const pushSubscriptionColumns = Object.keys(pushSubscriptionsTable.schema);
