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
 * Retrieve all mailboxes for a user (both system and user-created), sorted by name.
 */
export const getMailboxesByUser = async (
  user_id: string
): Promise<MailboxModel[]> => {
  const mailboxes = await mailboxesTable.query({ [MAILBOX_USER_ID]: user_id });
  return mailboxes.sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Find a mailbox by user_id and name (case-insensitive).
 * Returns null if not found.
 */
export const getMailboxByName = async (
  user_id: string,
  name: string
): Promise<MailboxModel | null> => {
  const mailboxes = await mailboxesTable.query({ [MAILBOX_USER_ID]: user_id });
  return (
    mailboxes.find((m) => m.name.toLowerCase() === name.toLowerCase()) ?? null
  );
};

/**
 * Find a mailbox by user_id and address (email address).
 * Used for system mailboxes tied to email accounts.
 */
export const getMailboxByAddress = async (
  user_id: string,
  address: string
): Promise<MailboxModel | null> => {
  return mailboxesTable.queryOne({
    [MAILBOX_USER_ID]: user_id,
    [MAILBOX_ADDRESS]: address,
  });
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

  const row = await mailboxesTable.insert(
    {
      [MAILBOX_USER_ID]: input.user_id,
      [MAILBOX_NAME]: input.name,
      [MAILBOX_ADDRESS]: input.address ?? null,
      [MAILBOX_PARENT_ID]: input.parent_id ?? null,
      [MAILBOX_SPECIAL_USE]: input.special_use ?? null,
      [MAILBOX_SUBSCRIBED]: input.subscribed !== false,
      [MAILBOX_UID_VALIDITY]: 1,
      [MAILBOX_UID_NEXT]: 1,
    },
    ["*"]
  );
  if (!row) return null;
  return new MailboxModel(row);
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
  const mailbox = await getMailboxByName(user_id, name);
  if (!mailbox) return "not_found";
  if (mailbox.special_use !== null) return "protected";

  await mailboxesTable.hardDelete(mailbox.mailbox_id);
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

  // Bump uid_validity when renaming — RFC 3501 requires clients to re-sync after rename
  await mailboxesTable.update(mailbox.mailbox_id, {
    [MAILBOX_NAME]: newName,
    [MAILBOX_UID_VALIDITY]: mailbox.uid_validity + 1,
  });
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
  const mailbox = await getMailboxByName(user_id, name);
  if (!mailbox) return false;
  const rows = await mailboxesTable.updateWhere(
    { [MAILBOX_ID]: mailbox.mailbox_id },
    { [MAILBOX_SUBSCRIBED]: subscribed },
    [MAILBOX_ID]
  );
  return rows.length > 0;
};
