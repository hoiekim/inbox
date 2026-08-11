import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import {
  USER_ID,
  UID_DOMAIN,
  MODSEQ,
  SENT,
  MAIL_UID_COUNTERS,
  UID_KIND,
  UID_SCOPE,
  LAST_UID,
  MAIL_MAILBOX_UID,
  MAILBOX,
  MAIL_ID,
  UID,
} from "../../models";
import { usesDomainUidSpace } from "./views";

/**
 * Build the atomic UID-reservation upsert.
 *
 * The counter row in `mail_uid_counters` holds the most recently assigned UID.
 * The INSERT seeds it once from the current `MAX(uid)` in `mails` (via `seedSql`,
 * which reuses $1=user_id and $4=sent), so a deployment with existing mail keeps
 * its sequence continuous — no UID renumbering, no UIDVALIDITY churn. Every call
 * after the first conflicts on the composite key and takes the row lock through
 * `DO UPDATE`, returning a strictly larger value.
 *
 * This is what closes the receive-path race (#617): a bare `MAX(uid)+1` read in
 * `convertMail` followed by a later INSERT is a TOCTOU — two concurrent receipts
 * read the same max and write the same UID. Funneling assignment through this
 * single atomic statement removes the window for every write path (receive, send,
 * IMAP APPEND), since they all assign through the two functions below.
 *
 * Pure (no DB) so the SQL shape is unit-testable without intercepting the pool.
 * `seedParams` supply any extra placeholders `seedSql` references ($5…).
 */
const buildReserveUidQuery = (
  user_id: string,
  kind: string,
  scope: string,
  sent: boolean,
  seedSql: string,
  seedParams: ParamValue[]
): { sql: string; values: ParamValue[] } => {
  const sql = `
    INSERT INTO ${MAIL_UID_COUNTERS} (${USER_ID}, ${UID_KIND}, ${UID_SCOPE}, ${SENT}, ${LAST_UID})
    VALUES ($1, $2, $3, $4, (${seedSql}))
    ON CONFLICT (${USER_ID}, ${UID_KIND}, ${UID_SCOPE}, ${SENT})
    DO UPDATE SET ${LAST_UID} = ${MAIL_UID_COUNTERS}.${LAST_UID} + 1
    RETURNING ${LAST_UID} AS next_uid
  `;
  return { sql, values: [user_id, kind, scope, sent, ...seedParams] };
};

/** Domain-wide UID-reservation query (kind="domain", no scope). */
export const buildDomainUidQuery = (
  user_id: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const seedSql = `
      SELECT COALESCE(MAX(${UID_DOMAIN}), 0) + 1 FROM mails
      WHERE ${USER_ID} = $1 AND ${SENT} = $4
    `;
  return buildReserveUidQuery(user_id, "domain", "", sent, seedSql, []);
};

/**
 * Per-account UID-reservation query (kind="account", scope=address).
 *
 * The seed on first-ever reservation for a (user, address, sent) tuple
 * sources from `mail_mailbox_uid.uid` — the authoritative per-mailbox UID
 * store after #702 PR 3 dropped `mails.uid_account`. The tuple predicate
 * matches any of the mailbox paths that the write side derives from
 * (address, sent): the per-account paths `INBOX/accounts/<local>` and
 * `Sent Messages/accounts/<local>`, plus the raw local part for
 * user-created mailboxes (`Archive` etc., where `boxToAccount` returns
 * `<name>@<domain>` and the write side stores the box name unchanged).
 * All three shapes coexist inside `mail_mailbox_uid.mailbox`; the
 * OR-union covers each with one indexed lookup.
 *
 * In practice this seed fires only on the very first reservation for a
 * (user, address, sent) triple — every subsequent call takes the DO
 * UPDATE branch and doesn't re-evaluate the seed. Existing deployments
 * already have counter rows for every mailbox that has ever received a
 * mail, so the seed's specific value only matters for the exact
 * new-mailbox-with-pre-existing-rows edge (nonexistent under any real
 * write path but defended against for hostile-data safety).
 */
export const buildAccountUidQuery = (
  user_id: string,
  account: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const localPart = account.split("@")[0];
  const perAccountPath = sent
    ? `Sent Messages/accounts/${localPart}`
    : `INBOX/accounts/${localPart}`;
  const seedSql = `
      SELECT COALESCE(MAX(${UID}), 0) + 1 FROM ${MAIL_MAILBOX_UID}
      WHERE ${USER_ID} = $1
        AND ${MAILBOX} IN ($5, $6)
    `;
  return buildReserveUidQuery(user_id, "account", account, sent, seedSql, [
    perAccountPath,
    localPart,
  ]);
};

const reserveNextUid = async (query: {
  sql: string;
  values: ParamValue[];
}): Promise<number> => {
  const result = await pool.query(query.sql, query.values);
  return parseInt(result.rows[0]?.next_uid || "1", 10);
};

// The counter is now the authoritative UID source, so a reservation failure must
// ABORT the save — never fall back to a fabricated UID. Returning 1 here (the old
// behavior) would assign a value colliding with the mailbox's first message, the
// exact duplicate-UID corruption this fix removes, now via the error path. Every
// caller aborts cleanly on a throw: SMTP receive NACKs (sender retries), the send
// route surfaces the error, and IMAP APPEND replies `NO` (client retries).
export const getDomainUidNext = async (
  user_id: string,
  sent: boolean = false
): Promise<number> => {
  try {
    return await reserveNextUid(buildDomainUidQuery(user_id, sent));
  } catch (error) {
    logger.error("Error getting next UID", {}, error);
    throw error;
  }
};

export const getAccountUidNext = async (
  user_id: string,
  account: string,
  sent: boolean = false
): Promise<number> => {
  try {
    return await reserveNextUid(buildAccountUidQuery(user_id, account, sent));
  } catch (error) {
    logger.error("Error getting account UID next", {}, error);
    throw error;
  }
};

/**
 * Record a UID assignment in the per-(user, mailbox, mail) mapping.
 * Returns the ACTUAL persisted UID — either the just-inserted `uid`, or
 * the pre-existing one when a row for `(user, mailbox, mail_id)` already
 * exists (COPY-twice / partial-failure retry). Callers that need to
 * report the destination UID over the wire (COPY's COPYUID, MOVE's
 * COPYUID response) MUST use this returned value, not the caller's
 * freshly-reserved `uid` param — otherwise the response advertises UIDs
 * that don't exist in the mapping (client `UID FETCH`es on those UIDs
 * come back empty).
 *
 * SQL uses `ON CONFLICT ... DO UPDATE SET uid = mail_mailbox_uid.uid` as
 * a no-op update: Postgres's `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 * returns nothing for the conflict path, but `DO UPDATE ... RETURNING`
 * always returns the row's current value. See #721 / #722.
 *
 * ABORTS ON FAILURE. `mail_mailbox_uid` is now the sole per-mailbox UID
 * source (#702 PR 3 dropped `mails.uid_account`), so a transient DB
 * fault at this write path means the mail is invisible in the
 * destination mailbox — every account-scoped SELECT / STATUS / FETCH /
 * SEARCH / STORE / EXPUNGE / MOVE joins this mapping and misses. The
 * mail row itself already landed on `mails` at the point saveMail calls
 * here, so `mails.uid_domain` still surfaces the message via INBOX /
 * unified Sent Messages — but any per-account view is silent-drop.
 *
 * Throw → propagates through pgSaveMail's outer catch (non-23505 branch
 * now re-throws, per #720) → receive.ts saveMail's catch (alarm + error
 * dump, then re-throws) → saveMailHandler's Promise.all rejects →
 * smtp.ts's .catch(cb) → SMTP 5xx → mailgun retries. IMAP APPEND / COPY /
 * MOVE take the parallel path via storeMail (converts undefined-or-throw
 * → false → tagged NO → client retries). Send-path swallows the throw
 * back to a mailgun-response-return (mail already sent; a "retry" would
 * duplicate delivery — the ops-side error dump preserves recovery info).
 */
export const writeMailboxUid = async (
  user_id: string,
  mailbox: string,
  mail_id: string,
  uid: number
): Promise<number> => {
  try {
    const result = await pool.query<{ uid: number }>(
      `INSERT INTO ${MAIL_MAILBOX_UID} (${USER_ID}, ${MAILBOX}, ${MAIL_ID}, ${UID})
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (${USER_ID}, ${MAILBOX}, ${MAIL_ID})
         DO UPDATE SET ${UID} = ${MAIL_MAILBOX_UID}.${UID}
       RETURNING ${UID}`,
      [user_id, mailbox, mail_id, uid]
    );
    return Number(result.rows[0]?.uid ?? uid);
  } catch (error) {
    logger.error(
      "Failed to record mail_mailbox_uid mapping — aborting to force retry",
      { user_id, mailbox, mail_id, uid },
      error
    );
    throw error;
  }
};

/**
 * Per-user mod-sequence reservation query (CONDSTORE, RFC 7162 §3.1).
 *
 * Reuses the same atomic `mail_uid_counters` upsert as UID assignment — a single
 * counter row keyed by kind="modseq" (scope="", sent=false, both unused for this
 * kind). RFC 7162 permits one mod-sequence namespace shared across a user's
 * mailboxes: any single mailbox still sees a strictly-increasing subsequence,
 * which is all the RFC requires. Using the atomic INSERT … ON CONFLICT … DO
 * UPDATE (rather than a bare `MAX(modseq)+1` read) makes concurrent flag/receipt
 * mutations race-free, exactly as it does for UIDs (#617).
 *
 * The counter seeds once from the live `MAX(modseq)` across all the user's mail,
 * so a deployment where the DEFAULT-1 backfill already set every existing row to
 * modseq=1 gets its first reservation at 2 — strictly greater than the initial
 * HIGHESTMODSEQ of 1. Pure (no DB) so the SQL shape is unit-testable.
 */
export const buildModseqQuery = (
  user_id: string
): { sql: string; values: ParamValue[] } => {
  const seedSql = `
      SELECT COALESCE(MAX(${MODSEQ}), 0) + 1 FROM mails
      WHERE ${USER_ID} = $1
    `;
  return buildReserveUidQuery(user_id, "modseq", "", false, seedSql, []);
};

// Reserve the next mod-sequence for a user's next mailbox mutation. Every
// insert/flag-change/expunge that alters a mailbox stamps the value returned
// here so HIGHESTMODSEQ (getHighestModseq) advances monotonically.
export const getNextModseq = async (user_id: string): Promise<number> => {
  try {
    return await reserveNextUid(buildModseqQuery(user_id));
  } catch (error) {
    logger.error("Error reserving next modseq", {}, error);
    throw error;
  }
};

/**
 * HIGHESTMODSEQ for a mailbox (RFC 7162 §3.1.2.1) — the largest mod-sequence of
 * any message routed to it. Computed on demand as `MAX(modseq)`; the
 * per-mailbox variant JOINs `mail_mailbox_uid`, matching the read cutover
 * from #702 PR 2b-2.
 *
 * Expunged rows are INTENTIONALLY included: an EXPUNGE bumps a message's modseq
 * before it vanishes, and HIGHESTMODSEQ must reflect that so a resyncing client
 * (QRESYNC, later phases) detects the removal. Returns 1 for an empty mailbox
 * (the DEFAULT-1 floor), never 0 — a 0 HIGHESTMODSEQ signals "no persistent
 * mod-sequences", which this store does support.
 *
 * Membership is deliberately NOT applied: the value only has to be an upper
 * bound the client can compare against, and a bound that ignores the filter
 * still moves whenever a message enters or leaves the box (both are stamped
 * writes). Filtering it would let the value fall — a mail leaving `Drafts`
 * would take the maximum with it — and a HIGHESTMODSEQ that decreases makes a
 * CONDSTORE client conclude nothing changed.
 */
export const getHighestModseq = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Promise<number> => {
  try {
    let sql: string;
    let values: ParamValue[];
    if (usesDomainUidSpace(mailbox)) {
      sql = `
        SELECT COALESCE(MAX(${MODSEQ}), 1) AS highest FROM mails
        WHERE ${USER_ID} = $1 AND ${SENT} = $2
      `;
      values = [user_id, sent];
    } else {
      sql = `
        SELECT COALESCE(MAX(m.${MODSEQ}), 1) AS highest FROM mails m
        JOIN ${MAIL_MAILBOX_UID} x
          ON x.${USER_ID} = m.${USER_ID}
          AND x.${MAILBOX} = $3
          AND x.${MAIL_ID} = m.${MAIL_ID}
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2
      `;
      values = [user_id, sent, mailbox];
    }
    const result = await pool.query(sql, values);
    return parseInt(result.rows[0]?.highest ?? "1", 10);
  } catch (error) {
    logger.error("Failed to get highest modseq", {}, error);
    return 1;
  }
};
