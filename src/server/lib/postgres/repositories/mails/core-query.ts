/**
 * The mutation SQL the core mail routes issue, built with no pool involved so
 * the emitted string and its bound parameters can be asserted directly. The
 * repository's own tests replace this module's siblings process-wide, so the
 * builders live outside them and can simply be called.
 *
 * ```ts
 * const { sql, values } = buildMarkMailSpamQuery(user_id, mail_id, is_spam, modseq);
 * const result = await pool.query(sql, values);
 * ```
 */
import { ParamValue } from "../../database";

/**
 * `is_spam IS DISTINCT FROM $1` makes a re-mark of the same value match no
 * row, so the reserved mod-sequence goes unused and a CONDSTORE client is not
 * told a mail changed when nothing did. The flip is a membership change — it
 * moves the mail out of INBOX — so it has to stamp `modseq` or the client
 * reads an unchanged HIGHESTMODSEQ and never resyncs.
 */
export const buildMarkMailSpamQuery = (
  user_id: string,
  mail_id: string,
  is_spam: boolean,
  modseq: number
): { sql: string; values: ParamValue[] } => ({
  sql: `UPDATE mails SET is_spam = $1, updated = NOW(), modseq = $4
       WHERE mail_id = $2 AND user_id = $3 AND is_spam IS DISTINCT FROM $1
       RETURNING mail_id`,
  values: [is_spam, mail_id, user_id, modseq],
});

/** Distinguishes "no such mail" from "the update matched nothing". */
export const buildMailExistsQuery = (
  user_id: string,
  mail_id: string
): { sql: string; values: ParamValue[] } => ({
  sql: `SELECT 1 FROM mails WHERE mail_id = $1 AND user_id = $2 LIMIT 1`,
  values: [mail_id, user_id],
});
