import crypto from "crypto";
import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import { MailModel, mailsTable, MAIL_ID, USER_ID, ENVELOPE_TO, DB_NOW } from "../../models";
import { getNextModseq, writeMailboxUid } from "./counters";

export interface SaveMailInput {
  user_id: string;
  message_id: string;
  subject?: string;
  date?: string;
  html?: string;
  text?: string;
  from_address?: object | null;
  from_text?: string | null;
  to_address?: object | null;
  to_text?: string | null;
  cc_address?: object | null;
  cc_text?: string | null;
  bcc_address?: object | null;
  bcc_text?: string | null;
  reply_to_address?: object | null;
  reply_to_text?: string | null;
  envelope_from?: object | null;
  envelope_to?: object | null;
  attachments?: object | null;
  read?: boolean;
  saved?: boolean;
  sent?: boolean;
  deleted?: boolean;
  draft?: boolean;
  answered?: boolean;
  expunged?: boolean;
  insight?: object | null;
  uid_domain?: number;
  uid_account?: number;
  spam_score?: number;
  spam_reasons?: string[] | null;
  is_spam?: boolean;
  /**
   * Destination account-scoped mailbox path (e.g. `INBOX/accounts/claude`,
   * `Sent Messages/accounts/claude`). When set alongside a non-zero
   * `uid_account`, `saveMail` mirrors the (user, mailbox, mail_id, uid)
   * tuple into `mail_mailbox_uid` — dual-write toward #702 PR-2b's read
   * cutover. Domain-scoped destinations (INBOX, unified Sent Messages)
   * are omitted deliberately: `uid_domain` is authoritative for those
   * views and the mapping is only interested in per-account UID spaces.
   */
  mailbox?: string;
}

export const saveMail = async (
  input: SaveMailInput
): Promise<{ _id: string } | undefined> => {
  try {
    const mail_id = crypto.randomUUID();
    // Stamp the new message with a fresh mod-sequence so it advances the
    // mailbox's HIGHESTMODSEQ (CONDSTORE, RFC 7162). Reserved before the INSERT,
    // like uid_domain/uid_account are in convertMail.
    const modseq = await getNextModseq(input.user_id);
    const data: Record<string, ParamValue | object | null> = {
      mail_id,
      user_id: input.user_id,
      message_id: input.message_id,
      subject: input.subject ?? "",
      date: input.date ?? new Date().toISOString(),
      html: input.html ?? "",
      text: input.text ?? "",
      from_address: input.from_address ? JSON.stringify(input.from_address) : null,
      from_text: input.from_text ?? null,
      to_address: input.to_address ? JSON.stringify(input.to_address) : null,
      to_text: input.to_text ?? null,
      cc_address: input.cc_address ? JSON.stringify(input.cc_address) : null,
      cc_text: input.cc_text ?? null,
      bcc_address: input.bcc_address ? JSON.stringify(input.bcc_address) : null,
      bcc_text: input.bcc_text ?? null,
      reply_to_address: input.reply_to_address
        ? JSON.stringify(input.reply_to_address)
        : null,
      reply_to_text: input.reply_to_text ?? null,
      envelope_from: input.envelope_from
        ? JSON.stringify(input.envelope_from)
        : null,
      envelope_to: input.envelope_to ? JSON.stringify(input.envelope_to) : null,
      attachments: input.attachments ? JSON.stringify(input.attachments) : null,
      read: input.read ?? false,
      saved: input.saved ?? false,
      sent: input.sent ?? false,
      deleted: input.deleted ?? false,
      draft: input.draft ?? false,
      answered: input.answered ?? false,
      expunged: input.expunged ?? false,
      insight: input.insight ? JSON.stringify(input.insight) : null,
      uid_domain: input.uid_domain ?? 0,
      uid_account: input.uid_account ?? 0,
      modseq,
      spam_score: input.spam_score ?? 0,
      spam_reasons: input.spam_reasons ? JSON.stringify(input.spam_reasons) : null,
      is_spam: input.is_spam ?? false,
    };

    const row = await mailsTable.insert(data, [MAIL_ID]);
    if (row) {
      const inserted_id = row[MAIL_ID] as string;
      // Dual-write toward #702 PR-2b's read cutover: mirror the account
      // UID into the per-mailbox mapping. Skipped when the destination
      // is domain-scoped (no mailbox passed) or no account UID was
      // reserved for this write. `writeMailboxUid` swallows its own
      // errors — this row is still authoritative in `mails.uid_account`
      // so a mapping-write miss doesn't lose the UID.
      if (input.mailbox && (input.uid_account ?? 0) > 0) {
        await writeMailboxUid(
          input.user_id,
          input.mailbox,
          inserted_id,
          input.uid_account as number
        );
      }
      return { _id: inserted_id };
    }
    return undefined;
  } catch (error: unknown) {
    // Unique constraint violation on (user_id, message_id):
    // This can happen legitimately when one email is delivered to multiple accounts
    // (e.g. account1@inbox.app, account2@inbox.app). The sender uses separate
    // envelopes, but the message_id is the same. In that case we must merge the
    // envelope_to values so we can correctly identify BCC recipients later.
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      const existing = await getMailByMessageId(input.user_id, input.message_id);
      if (!existing) return undefined;

      if (input.envelope_to) {
        type AddressEntry = { address?: string };
        const existingTo = (existing.envelope_to as AddressEntry[] | null) ?? [];
        const incomingTo = input.envelope_to as AddressEntry[];
        const seen = new Set(existingTo.map((a) => a.address));
        const merged = [
          ...existingTo,
          ...incomingTo.filter((a) => !seen.has(a.address)),
        ];
        await mailsTable.updateWhere(
          { user_id: input.user_id, message_id: input.message_id },
          { [ENVELOPE_TO]: JSON.stringify(merged), updated: DB_NOW }
        );
      }

      // Same 23505 (duplicate message_id) → one mail delivered to two
      // envelope-to addresses that both matched the user's accounts.
      // Register the NEW envelope-to account's mailbox mapping against
      // the existing mail_id so both account inboxes carry a UID for
      // this message.
      if (input.mailbox && (input.uid_account ?? 0) > 0) {
        await writeMailboxUid(
          input.user_id,
          input.mailbox,
          existing.mail_id,
          input.uid_account as number
        );
      }
      return { _id: existing.mail_id };
    }

    logger.error("Failed to save mail", {}, error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
};

/**
 * Get a mail by user_id and message_id.
 * Used to find existing mail when a conflict occurs.
 */
export const getMailByMessageId = async (
  user_id: string,
  message_id: string
): Promise<MailModel | undefined> => {
  const result = await mailsTable.query({ user_id, message_id });
  return result[0];
};

export const getMailById = async (
  user_id: string,
  mail_id: string
): Promise<MailModel | null> => {
  try {
    return await mailsTable.queryOne({ [MAIL_ID]: mail_id, [USER_ID]: user_id });
  } catch (error) {
    logger.error("Failed to get mail by ID", {}, error);
    return null;
  }
};

export const markMailRead = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  try {
    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: mail_id, [USER_ID]: user_id },
      { read: true, updated: DB_NOW },
      [MAIL_ID]
    );
    return rows.length > 0;
  } catch (error) {
    logger.error("Failed to mark mail as read", {}, error);
    return false;
  }
};

export const markMailSaved = async (
  user_id: string,
  mail_id: string,
  saved: boolean
): Promise<boolean> => {
  try {
    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: mail_id, [USER_ID]: user_id },
      { saved, updated: DB_NOW },
      [MAIL_ID]
    );
    return rows.length > 0;
  } catch (error) {
    logger.error("Failed to mark mail as saved", {}, error);
    return false;
  }
};

export const deleteMail = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  try {
    const count = await mailsTable.deleteWhere({
      [MAIL_ID]: mail_id,
      [USER_ID]: user_id
    });
    return count > 0;
  } catch (error) {
    logger.error("Failed to delete mail", {}, error);
    return false;
  }
};

/**
 * Mark or unmark a mail as spam.
 *
 * Returns:
 *   - `found`: true if the (user, mail) pair exists, regardless of current is_spam value
 *   - `changed`: true if the row's is_spam value was actually flipped
 *
 * Distinguishing "no change" from "not found" lets the caller skip classifier
 * training on idempotent re-marks while still surfacing real auth failures.
 */
export const markMailSpam = async (
  user_id: string,
  mail_id: string,
  is_spam: boolean
): Promise<{ found: boolean; changed: boolean }> => {
  try {
    const result = await pool.query(
      `UPDATE mails SET is_spam = $1, updated = NOW()
         WHERE mail_id = $2 AND user_id = $3 AND is_spam IS DISTINCT FROM $1
         RETURNING mail_id`,
      [is_spam, mail_id, user_id]
    );
    if ((result.rowCount ?? 0) > 0) return { found: true, changed: true };
    const exists = await pool.query(
      `SELECT 1 FROM mails WHERE mail_id = $1 AND user_id = $2 LIMIT 1`,
      [mail_id, user_id]
    );
    return { found: (exists.rowCount ?? 0) > 0, changed: false };
  } catch (error) {
    logger.error("Failed to mark mail as spam", {}, error);
    return { found: false, changed: false };
  }
};
