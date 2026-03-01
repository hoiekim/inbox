/**
 * Spam Allowlist Model
 * 
 * Stores per-user allowlist entries for trusted senders.
 * Patterns can be exact (user@example.com) or domain wildcards (*@example.com).
 */

import { Model, createTable } from "./base";
import { SPAM_ALLOWLIST, USER_ID } from "./common";

// Column names
export const ALLOWLIST_ID = "allowlist_id";
export const PATTERN = "pattern";
export const CREATED_AT = "created_at";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";

export interface SpamAllowlistJSON {
  allowlist_id: string;
  user_id: string;
  pattern: string;
  created_at: string;
}

const spamAllowlistSchema = {
  [ALLOWLIST_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [PATTERN]: "TEXT NOT NULL",
  [CREATED_AT]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
};

type SpamAllowlistSchema = typeof spamAllowlistSchema;

export class SpamAllowlistModel extends Model<SpamAllowlistJSON, SpamAllowlistSchema> {
  declare allowlist_id: string;
  declare user_id: string;
  declare pattern: string;
  declare created_at: string;

  static typeChecker = {
    allowlist_id: isString,
    user_id: isString,
    pattern: isString,
    created_at: isString,
  };

  constructor(data: unknown) {
    super(data, SpamAllowlistModel.typeChecker);
  }

  toJSON(): SpamAllowlistJSON {
    return {
      allowlist_id: this.allowlist_id,
      user_id: this.user_id,
      pattern: this.pattern,
      created_at: this.created_at,
    };
  }
}

export const spamAllowlistTable = createTable({
  name: SPAM_ALLOWLIST,
  primaryKey: ALLOWLIST_ID,
  schema: spamAllowlistSchema,
  ModelClass: SpamAllowlistModel,
  supportsSoftDelete: false,
  indexes: [
    { column: USER_ID },
  ],
  // Note: UNIQUE constraint on (user_id, pattern) is enforced via 
  // ON CONFLICT in addAllowlistEntry
});
