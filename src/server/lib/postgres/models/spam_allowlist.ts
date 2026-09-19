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

/**
 * `pattern` is `TEXT`, so the column imposes no ceiling of its own. The cap is
 * on bytes rather than characters because a non-ASCII character occupies up to
 * four of them, and bytes are what the per-received-mail lookup pays. 320 is
 * the longest address RFC 5321 permits (64-byte local part, `@`, 255-byte
 * domain), so no legal address is refused.
 */
export const ALLOWLIST_PATTERN_MAX_BYTES = 320;

/**
 * Ceiling on allowlist entries per user. The allowlist lookup runs on every
 * received mail and no index covers `LOWER(pattern)`, so every row for that
 * user is scanned — the row count is what bounds that scan.
 */
export const ALLOWLIST_COUNT_MAX = 1000;

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";

/**
 * The outcome of an add attempt. A refusal names its own reason so the route
 * can answer with the message the user acts on — `exists` is already-done to
 * someone re-adding a trusted sender, while `at_limit` and `too_long` are not.
 */
export type AddAllowlistEntryResult =
  | { status: "created"; entry: SpamAllowlistModel }
  | { status: "exists" }
  | { status: "at_limit" }
  | { status: "too_long" };

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
  readonly constraints: Constraints = [`UNIQUE(${USER_ID}, ${PATTERN})`];
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
   * Inserts a new allowlist entry, refusing a pattern over
   * {@link ALLOWLIST_PATTERN_MAX_BYTES} and a user already at
   * {@link ALLOWLIST_COUNT_MAX} rows.
   *
   * Both ceilings live here because this is the only write path to the table.
   * The count is a subquery of the INSERT rather than a preceding SELECT so
   * the row being counted and the row being written are decided together, and
   * a zero-row result is disambiguated by probing for the pattern first — an
   * entry that already exists reports as existing even at the ceiling.
   */
  async addEntry(userId: string, pattern: string): Promise<AddAllowlistEntryResult> {
    const normalizedPattern = pattern.toLowerCase();
    if (Buffer.byteLength(normalizedPattern, "utf8") > ALLOWLIST_PATTERN_MAX_BYTES) {
      return { status: "too_long" };
    }

    const sql = `
      INSERT INTO ${this.name} (${USER_ID}, ${PATTERN})
      SELECT $1, $2
      WHERE (SELECT COUNT(*) FROM ${this.name} WHERE ${USER_ID} = $1) < $3
      ON CONFLICT (${USER_ID}, ${PATTERN}) DO NOTHING
      RETURNING *
    `;
    const result = await pool.query<SpamAllowlistJSON>(sql, [
      userId,
      normalizedPattern,
      ALLOWLIST_COUNT_MAX,
    ]);
    if (result.rows.length > 0) {
      return { status: "created", entry: new SpamAllowlistModel(result.rows[0]) };
    }

    const probe = await pool.query(
      `SELECT 1 FROM ${this.name} WHERE ${USER_ID} = $1 AND ${PATTERN} = $2 LIMIT 1`,
      [userId, normalizedPattern]
    );
    return (probe.rowCount ?? 0) > 0 ? { status: "exists" } : { status: "at_limit" };
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
