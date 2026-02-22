import bcrypt from "bcryptjs";
import { MaskedUser, User, usersTable, USER_ID, EMAIL, IMAP_UID_VALIDITY } from "../models";

export type IndexUserInput = Omit<User, "user_id"> & { user_id?: string };
export type PartialUser = { user_id: string } & Partial<User>;

export const maskUser = (user: User): MaskedUser => {
  const { user_id, username, email } = user;
  return { user_id, username, email };
};

export const writeUser = async (
  user: IndexUserInput
): Promise<{ _id: string } | undefined> => {
  const { user_id, username, password, email } = user;
  const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;

  try {
    const row: Record<string, unknown> = { username, password: hashedPassword };
    if (user_id) row.user_id = user_id;
    if (email) row.email = email;

    const result = await usersTable.upsert(row);
    if (result) return { _id: result.user_id as string };
    return undefined;
  } catch (error) {
    console.error("Failed to write user:", error);
    return undefined;
  }
};

export const searchUser = async (
  user: Partial<MaskedUser>
): Promise<User | undefined> => {
  try {
    const filters: Record<string, unknown> = {};
    if (user.user_id) filters[USER_ID] = user.user_id;
    if (user.username) filters.username = user.username;
    if (user.email) filters[EMAIL] = user.email;

    if (Object.keys(filters).length === 0) return undefined;

    const model = await usersTable.queryOne(filters);
    return model?.toUser();
  } catch (error) {
    console.error("Failed to search user:", error);
    return undefined;
  }
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

  try {
    const model = await usersTable.update(user_id, updates);
    return model !== null;
  } catch (error) {
    console.error("Failed to update user:", error);
    return false;
  }
};

export const getUserById = async (
  user_id: string
): Promise<User | undefined> => {
  try {
    const model = await usersTable.queryOne({ [USER_ID]: user_id });
    return model?.toUser();
  } catch (error) {
    console.error("Failed to get user by ID:", error);
    return undefined;
  }
};

export const deleteUser = async (user_id: string): Promise<boolean> => {
  try {
    return await usersTable.softDelete(user_id);
  } catch (error) {
    console.error("Failed to delete user:", error);
    return false;
  }
};

export const getUserByEmail = async (
  email: string
): Promise<User | undefined> => {
  try {
    const model = await usersTable.queryOne({ [EMAIL]: email });
    return model?.toUser();
  } catch (error) {
    console.error("Failed to get user by email:", error);
    return undefined;
  }
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
  try {
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
  } catch (error) {
    console.error("Failed to get IMAP UIDVALIDITY:", error);
    // Return a fallback value - timestamp ensures uniqueness
    return Math.floor(Date.now() / 1000);
  }
};
