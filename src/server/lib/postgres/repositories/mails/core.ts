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
  /**
   * Per-mailbox UID reserved via `getMailboxUidNext` for the mailbox this
   * write targets. Not persisted on the `mails` table (dropped in #702 PR 3);
   * `saveMail` mirrors it into `mail_mailbox_uid.uid` (keyed by
   * `input.mailbox`), which is now the sole per-mailbox UID source. Skip when
   * the write is domain-only (INBOX / unified Sent Messages) — those views
   * enumerate by `uid_domain`, not the mapping.
   */
  uid_mailbox?: number;
  spam_score?: number;
  spam_reasons?: string[] | null;
  is_spam?: boolean;
  /**
   * Destination mailbox path (per-account like `INBOX/accounts/claude` /
   * `Sent Messages/accounts/claude`, or user-created like `Archive`). When
   * set alongside a non-zero `uid_mailbox`, `saveMail` writes the (user,
   * mailbox, mail_id, uid) tuple into `mail_mailbox_uid` — the sole
   * per-mailbox UID source after #702 PR 3. Domain-scoped destinations
   * (INBOX, unified Sent Messages) are omitted deliberately: `uid_domain`
   * is authoritative for those views.
   */
  mailbox?: string;
}

export const saveMail = async (
  input: SaveMailInput
): Promise<{ _id: string; uid_mailbox?: number; uid_domain?: number } | undefined> => {
  try {
    const mail_id = crypto.randomUUID();
    // Stamp the new message with a fresh mod-sequence so it advances the
    // mailbox's HIGHESTMODSEQ (CONDSTORE, RFC 7162). Reserved before the INSERT,
    // like uid_domain/uid_mailbox are in convertMail.
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
      modseq,
      spam_score: input.spam_score ?? 0,
      spam_reasons: input.spam_reasons ? JSON.stringify(input.spam_reasons) : null,
      is_spam: input.is_spam ?? false,
    };

    const row = await mailsTable.insert(data, [MAIL_ID]);
    if (row) {
      const inserted_id = row[MAIL_ID] as string;
      // Write the per-mailbox mapping row. `mail_mailbox_uid` is now the
      // sole per-mailbox UID source (PR 3 dropped `mails.uid_account`),
      // so this write is authoritative — a miss here means the mail is
      // invisible to the mailbox's account-scoped reads. Callers need
      // the returned persisted UID (may differ from input.uid_mailbox
      // when a row already exists — a partial-failure retry hits the
      // ON CONFLICT DO UPDATE and returns the first-attempt UID; see
      // #721 / #722).
      let persistedUid: number | undefined;
      if (input.mailbox && (input.uid_mailbox ?? 0) > 0) {
        persistedUid = await writeMailboxUid(
          input.user_id,
          input.mailbox,
          inserted_id,
          input.uid_mailbox as number
        );
      }
      // On the INSERT branch the row we just wrote has our input.uid_domain
      // (no conflict) — return it verbatim so storeMail can reconcile
      // mail.uid.domain for domain-scoped COPY/APPEND wire responses.
      return {
        _id: inserted_id,
        uid_mailbox: persistedUid,
        uid_domain: input.uid_domain,
      };
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

      // The 23505 branch fires for cross-delivery re-sends of the same
      // Message-ID from distinct SMTP sessions — a mailgun retry landing
      // on a different envelope, or a listserv fanning the same message
      // to multiple recipients under separate connections. Each session
      // has its own `input.mailbox`; the mapping row (existing_mail_id,
      // new_mailbox, new_uid) surfaces the second delivery in the second
      // account's UID space. Same-mailbox race between two concurrent
      // saveIncomingMail calls hits `writeMailboxUid`'s
      // `ON CONFLICT (user_id, mailbox, mail_id) DO NOTHING`, so the
      // loser's counter tick and mapping-insert round-trip are wasted
      // (rare, sub-ms, off the SMTP reply path) — the winner's row wins.
      let persistedUid: number | undefined;
      if (input.mailbox && (input.uid_mailbox ?? 0) > 0) {
        persistedUid = await writeMailboxUid(
          input.user_id,
          input.mailbox,
          existing.mail_id,
          input.uid_mailbox as number
        );
      }
      // On the 23505 merge branch the caller's input.uid_domain is a
      // fresh reservation, but the row `existing` already has its own
      // uid_domain from the first attempt. Return the existing value
      // so storeMail reconciles mail.uid.domain — otherwise a
      // domain-scoped COPY/APPEND that partial-failure-retries would
      // report a fresh uid_domain in COPYUID/APPENDUID that has no
      // matching mails row.
      return {
        _id: existing.mail_id,
        uid_mailbox: persistedUid,
        uid_domain: existing.uid_domain,
      };
    }

    // Non-23505 error (mails INSERT transient, mail_mailbox_uid mapping-write
    // failure via writeMailboxUid, etc.). Throw rather than return undefined
    // so the SMTP-receive / IMAP-write caller replies 5xx / NO and the sender
    // or client retries — silent-drop is worse than loud failure now that
    // `mail_mailbox_uid` is the sole per-mailbox UID source (#702 PR 3).
    logger.error("Failed to save mail", {}, error instanceof Error ? error : new Error(String(error)));
    throw error;
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
