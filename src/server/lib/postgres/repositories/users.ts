import bcrypt from "bcryptjs";
import { pool } from "../client";
import {
  MaskedUser,
  User,
  usersTable,
  USER_ID,
  USERNAME,
  PASSWORD,
  PASSWORD_VERSION,
  TOKEN,
  EXPIRY,
  EMAIL,
  IMAP_UID_VALIDITY,
  USERS,
} from "../models";

export type IndexUserInput = Omit<User, "user_id" | "password"> & {
  user_id?: string;
  /**
   * Omit to leave an existing row's stored password untouched: the column is
   * dropped from the INSERT, and `buildUpsert` carries onto the conflict clause
   * only the columns the INSERT wrote. A row created without one has no
   * password and cannot sign in until one is set.
   */
  password?: string;
};
export type PartialUser = { user_id: string } & Partial<User>;

export const maskUser = (user: User): MaskedUser => {
  const { user_id, username, email } = user;
  return { user_id, username, email };
};

export const writeUser = async (
  user: IndexUserInput
): Promise<{ _id: string } | undefined> => {
  const { user_id, username, password, email, password_version } = user;
  const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;

  const row: Record<string, unknown> = { username, password: hashedPassword };
  if (user_id) row.user_id = user_id;
  if (email) row.email = email;
  // Carried onto the conflict clause only when the caller passes it, so a
  // boot-path rotation can bump the generation in the SAME upsert that
  // writes the new hash. Callers that omit it leave the stored generation
  // alone (a new row takes the column DEFAULT 1).
  if (password_version !== undefined) row[PASSWORD_VERSION] = password_version;

  const result = await usersTable.upsert(row);
  if (result) return { _id: result.user_id as string };
  return undefined;
};

/**
 * Rotate a user's credential and bump its generation atomically.
 *
 * The query builder only binds values, so a `SET password_version = ... + 1`
 * cannot go through `usersTable.update` — this is the direct-SQL exception,
 * like the mailbox lookups that need a comparison the builder cannot express.
 * The bump, the new hash, and the token/expiry clearing are one UPDATE, so
 * two concurrent rotations cannot both read generation N and both write N+1
 * with different hashes. Returns the generation the row now carries (the
 * caller signs with this, never with a value it computed before the write),
 * or null when the row does not exist. Rows that predate the fence read
 * back null, and COALESCE treats those as generation 1, so their first
 * bumped generation is 2.
 */
export const rotateUserPassword = async (
  user_id: string,
  updates: {
    passwordHash: string;
    username: string;
    token: string | null;
    expiry: string | null;
  }
): Promise<number | null> => {
  const result = await pool.query(
    `UPDATE ${USERS} SET ${PASSWORD} = $2, ${PASSWORD_VERSION} = COALESCE(${PASSWORD_VERSION}, 1) + 1, ${USERNAME} = $3, ${TOKEN} = $4, ${EXPIRY} = $5, updated = CURRENT_TIMESTAMP WHERE ${USER_ID} = $1 RETURNING ${PASSWORD_VERSION}`,
    [
      user_id,
      updates.passwordHash,
      updates.username,
      updates.token,
      updates.expiry,
    ]
  );
  const version = result.rows[0]?.[PASSWORD_VERSION];
  return typeof version === "number" ? version : null;
};

export const searchUser = async (
  user: Partial<MaskedUser>
): Promise<User | undefined> => {
  const filters: Record<string, unknown> = {};
  if (user.user_id) filters[USER_ID] = user.user_id;
  if (user.username) filters.username = user.username;
  if (user.email) filters[EMAIL] = user.email;

  if (Object.keys(filters).length === 0) return undefined;

  const model = await usersTable.queryOne(filters);
  return model?.toUser();
};

export const updateUser = async (user: PartialUser): Promise<boolean> => {
  if (!user) return false;
  const { user_id, username, password, email } = user;

  const updates: Record<string, unknown> = {};
  if (username !== undefined) updates.username = username;
  if (password !== undefined)
    updates.password = await bcrypt.hash(password, 10);
  if (email !== undefined) updates.email = email;

  if (Object.keys(updates).length === 0) return false;

  const model = await usersTable.update(user_id, updates);
  return model !== null;
};

export const getUserById = async (
  user_id: string
): Promise<User | undefined> => {
  const model = await usersTable.queryOne({ [USER_ID]: user_id });
  return model?.toUser();
};

export const deleteUser = async (user_id: string): Promise<boolean> => {
  return await usersTable.softDelete(user_id);
};

export const getUserByEmail = async (
  email: string
): Promise<User | undefined> => {
  const model = await usersTable.queryOne({ [EMAIL]: email });
  return model?.toUser();
};

/**
 * Get the IMAP UIDVALIDITY for a user.
 * Per RFC 3501, UIDVALIDITY is a value that, combined with UIDs, uniquely
 * identifies messages. If it changes, clients must discard cached message state.
 *
 * On first IMAP access, initializes UIDVALIDITY to current Unix timestamp.
 * This ensures uniqueness and that the value only increases over time.
 */
export const getImapUidValidity = async (user_id: string): Promise<number> => {
  const model = await usersTable.queryOne({ [USER_ID]: user_id });
  if (!model) {
    throw new Error(`User not found: ${user_id}`);
  }

  // If already set, return the stored value
  if (model.imap_uid_validity !== null) {
    return model.imap_uid_validity;
  }

  // Initialize to current Unix timestamp (seconds since epoch)
  // This ensures uniqueness and monotonically increasing values
  const uidValidity = Math.floor(Date.now() / 1000);

  await usersTable.update(user_id, { [IMAP_UID_VALIDITY]: uidValidity });

  return uidValidity;
};
