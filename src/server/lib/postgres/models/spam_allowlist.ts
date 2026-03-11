/**
 * Spam Allowlist Model
 * 
 * Stores per-user allowlist entries for trusted senders.
 * Patterns can be exact (user@example.com) or domain wildcards (*@example.com).
 */

import { Model, Table, Constraints } from "./base";
import { pool } from "../client";
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

class SpamAllowlistTable extends Table<SpamAllowlistJSON, SpamAllowlistSchema, SpamAllowlistModel> {
  readonly name = SPAM_ALLOWLIST;
  readonly primaryKey = ALLOWLIST_ID;
  readonly schema = spamAllowlistSchema;
  readonly constraints: Constraints = [];
  readonly indexes = [{ column: USER_ID }];
  readonly ModelClass = SpamAllowlistModel;
  readonly supportsSoftDelete = false;

  /**
   * Returns all allowlist entries for a user, newest first.
   */
  async getAllForUser(userId: string): Promise<SpamAllowlistModel[]> {
    const sql = `SELECT * FROM ${this.name} WHERE ${USER_ID} = $1 ORDER BY ${CREATED_AT} DESC`;
    const result = await pool.query<SpamAllowlistJSON>(sql, [userId]);
    return result.rows.map((row) => new SpamAllowlistModel(row));
  }

  /**
   * Returns true if the email address matches any exact or domain-wildcard entry for the user.
   */
  async isAllowlisted(userId: string, emailAddress: string): Promise<boolean> {
    const normalizedEmail = emailAddress.toLowerCase();
    const domain = normalizedEmail.split("@")[1];
    const sql = `
      SELECT COUNT(*) AS count FROM ${this.name}
      WHERE ${USER_ID} = $1
        AND (LOWER(${PATTERN}) = $2 OR LOWER(${PATTERN}) = $3)
    `;
    const result = await pool.query<{ count: string }>(sql, [userId, normalizedEmail, `*@${domain}`]);
    return parseInt(result.rows[0]?.count || "0") > 0;
  }

  /**
   * Inserts a new allowlist entry; returns null if the entry already exists.
   */
  async addEntry(userId: string, pattern: string): Promise<SpamAllowlistModel | null> {
    const normalizedPattern = pattern.toLowerCase();
    const sql = `
      INSERT INTO ${this.name} (${USER_ID}, ${PATTERN})
      VALUES ($1, $2)
      ON CONFLICT (${USER_ID}, ${PATTERN}) DO NOTHING
      RETURNING *
    `;
    const result = await pool.query<SpamAllowlistJSON>(sql, [userId, normalizedPattern]);
    return result.rows.length > 0 ? new SpamAllowlistModel(result.rows[0]) : null;
  }

  /**
   * Deletes an entry matching the user + pattern (case-insensitive).
   * Returns true if a row was deleted.
   */
  async removeByPattern(userId: string, pattern: string): Promise<boolean> {
    const normalizedPattern = pattern.toLowerCase();
    const sql = `
      DELETE FROM ${this.name}
      WHERE ${USER_ID} = $1 AND LOWER(${PATTERN}) = $2
    `;
    const result = await pool.query(sql, [userId, normalizedPattern]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Deletes an entry by its primary key, scoped to the user for safety.
   * Returns true if a row was deleted.
   */
  async removeById(userId: string, allowlistId: string): Promise<boolean> {
    const sql = `
      DELETE FROM ${this.name}
      WHERE ${USER_ID} = $1 AND ${ALLOWLIST_ID} = $2
    `;
    const result = await pool.query(sql, [userId, allowlistId]);
    return (result.rowCount ?? 0) > 0;
  }
}

export const spamAllowlistTable = new SpamAllowlistTable();
