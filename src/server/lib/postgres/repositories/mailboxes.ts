import { pool } from "../client";
import {
  MailboxModel,
  mailboxesTable,
  MAILBOX_ID,
  MAILBOX_USER_ID,
  MAILBOX_NAME,
  MAILBOX_ADDRESS,
  MAILBOX_PARENT_ID,
  MAILBOX_UID_VALIDITY,
  MAILBOX_UID_NEXT,
  MAILBOX_SUBSCRIBED,
  MAILBOX_SPECIAL_USE,
} from "../models";

/**
 * Retrieve all mailboxes for a user (both system and user-created).
 */
export const getMailboxesByUser = async (
  user_id: string
): Promise<MailboxModel[]> => {
  const sql = `
    SELECT * FROM ${mailboxesTable.name}
    WHERE ${MAILBOX_USER_ID} = $1
    ORDER BY ${MAILBOX_NAME} ASC
  `;
  const result = await pool.query(sql, [user_id]);
  return result.rows.map((row) => new MailboxModel(row));
};

/**
 * Find a mailbox by user_id and name (case-insensitive).
 * Returns null if not found.
 */
export const getMailboxByName = async (
  user_id: string,
  name: string
): Promise<MailboxModel | null> => {
  const sql = `
    SELECT * FROM ${mailboxesTable.name}
    WHERE ${MAILBOX_USER_ID} = $1
      AND LOWER(${MAILBOX_NAME}) = LOWER($2)
    LIMIT 1
  `;
  const result = await pool.query(sql, [user_id, name]);
  if (result.rows.length === 0) return null;
  return new MailboxModel(result.rows[0]);
};

/**
 * Find a mailbox by user_id and address (email address).
 * Used for system mailboxes tied to email accounts.
 */
export const getMailboxByAddress = async (
  user_id: string,
  address: string
): Promise<MailboxModel | null> => {
  const sql = `
    SELECT * FROM ${mailboxesTable.name}
    WHERE ${MAILBOX_USER_ID} = $1
      AND ${MAILBOX_ADDRESS} = $2
    LIMIT 1
  `;
  const result = await pool.query(sql, [user_id, address]);
  if (result.rows.length === 0) return null;
  return new MailboxModel(result.rows[0]);
};

export interface CreateMailboxInput {
  user_id: string;
  name: string;
  address?: string | null;
  parent_id?: string | null;
  special_use?: string | null;
  subscribed?: boolean;
}

/**
 * Create a new user-defined mailbox.
 * Returns the created mailbox, or null if a mailbox with that name already exists.
 */
export const createMailbox = async (
  input: CreateMailboxInput
): Promise<MailboxModel | null> => {
  const existing = await getMailboxByName(input.user_id, input.name);
  if (existing) return null; // already exists

  const sql = `
    INSERT INTO ${mailboxesTable.name} (
      ${MAILBOX_USER_ID},
      ${MAILBOX_NAME},
      ${MAILBOX_ADDRESS},
      ${MAILBOX_PARENT_ID},
      ${MAILBOX_SPECIAL_USE},
      ${MAILBOX_SUBSCRIBED},
      ${MAILBOX_UID_VALIDITY},
      ${MAILBOX_UID_NEXT}
    )
    VALUES ($1, $2, $3, $4, $5, $6, 1, 1)
    RETURNING *
  `;
  const values = [
    input.user_id,
    input.name,
    input.address ?? null,
    input.parent_id ?? null,
    input.special_use ?? null,
    input.subscribed !== false,
  ];
  const result = await pool.query(sql, values);
  if (result.rows.length === 0) return null;
  return new MailboxModel(result.rows[0]);
};

/**
 * Delete a user-created mailbox by name.
 * System mailboxes (with special_use set) cannot be deleted.
 * Returns true if deleted, false if not found or protected.
 */
export const deleteMailboxByName = async (
  user_id: string,
  name: string
): Promise<"deleted" | "not_found" | "protected"> => {
  // Disallow deletion of system mailboxes
  const mailbox = await getMailboxByName(user_id, name);
  if (!mailbox) return "not_found";
  if (mailbox.special_use !== null) return "protected";

  const sql = `
    DELETE FROM ${mailboxesTable.name}
    WHERE ${MAILBOX_USER_ID} = $1
      AND ${MAILBOX_ID} = $2
  `;
  await pool.query(sql, [user_id, mailbox.mailbox_id]);
  return "deleted";
};

/**
 * Rename a mailbox. Validates old name exists and new name is available.
 * System mailboxes cannot be renamed.
 */
export const renameMailbox = async (
  user_id: string,
  oldName: string,
  newName: string
): Promise<"renamed" | "not_found" | "protected" | "name_taken"> => {
  const mailbox = await getMailboxByName(user_id, oldName);
  if (!mailbox) return "not_found";
  if (mailbox.special_use !== null) return "protected";

  const existing = await getMailboxByName(user_id, newName);
  if (existing) return "name_taken";

  // Bump uid_validity when renaming (RFC 3501 requirement)
  const sql = `
    UPDATE ${mailboxesTable.name}
    SET ${MAILBOX_NAME} = $1,
        ${MAILBOX_UID_VALIDITY} = ${MAILBOX_UID_VALIDITY} + 1
    WHERE ${MAILBOX_USER_ID} = $2
      AND ${MAILBOX_ID} = $3
  `;
  await pool.query(sql, [newName, user_id, mailbox.mailbox_id]);
  return "renamed";
};

/**
 * Update the subscribed flag for a mailbox.
 */
export const setMailboxSubscribed = async (
  user_id: string,
  name: string,
  subscribed: boolean
): Promise<boolean> => {
  const sql = `
    UPDATE ${mailboxesTable.name}
    SET ${MAILBOX_SUBSCRIBED} = $1
    WHERE ${MAILBOX_USER_ID} = $2
      AND LOWER(${MAILBOX_NAME}) = LOWER($3)
    RETURNING ${MAILBOX_ID}
  `;
  const result = await pool.query(sql, [subscribed, user_id, name]);
  return result.rows.length > 0;
};
