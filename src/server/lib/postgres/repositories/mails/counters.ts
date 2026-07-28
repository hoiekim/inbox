import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import {
  USER_ID,
  UID_DOMAIN,
  UID_ACCOUNT,
  MODSEQ,
  TO_ADDRESS,
  FROM_ADDRESS,
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

/** Per-account UID-reservation query (kind="account", scope=address). */
export const buildAccountUidQuery = (
  user_id: string,
  account: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const addressJson = JSON.stringify([{ address: account }]);
  const addressCondition = sent
    ? `${FROM_ADDRESS} @> $5::jsonb`
    : `(${TO_ADDRESS} @> $5::jsonb OR cc_address @> $5::jsonb OR bcc_address @> $5::jsonb OR envelope_to @> $5::jsonb)`;
  const seedSql = `
      SELECT COALESCE(MAX(${UID_ACCOUNT}), 0) + 1 FROM mails
      WHERE ${USER_ID} = $1
        AND ${addressCondition}
        AND ${SENT} = $4
    `;
  return buildReserveUidQuery(user_id, "account", account, sent, seedSql, [
    addressJson,
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
 * Record a UID assignment in the per-(user, mailbox, mail) mapping. `ON
 * CONFLICT DO NOTHING` — a re-emit for a (user, mailbox, mail) already
 * mapped is a no-op, not an error (COPY into a mailbox where this mail
 * already has a UID). Insert failure is logged rather than thrown while
 * `mails.uid_account` is the authoritative UID source; when the mapping
 * table becomes authoritative, this path needs to abort on failure.
 */
export const writeMailboxUid = async (
  user_id: string,
  mailbox: string,
  mail_id: string,
  uid: number
): Promise<void> => {
  try {
    await pool.query(
      `INSERT INTO ${MAIL_MAILBOX_UID} (${USER_ID}, ${MAILBOX}, ${MAIL_ID}, ${UID})
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (${USER_ID}, ${MAILBOX}, ${MAIL_ID}) DO NOTHING`,
      [user_id, mailbox, mail_id, uid]
    );
  } catch (error) {
    logger.warn(
      "Failed to record mail_mailbox_uid mapping",
      { user_id, mailbox, mail_id, uid },
      error
    );
  }
};

/**
 * Read-path counterpart to `writeMailboxUid`: guarantees every requested
 * `mail_id` has a mapping row for `(user_id, mailbox, mail_id)` and
 * returns the full `mail_id → uid` map.
 *
 * The account-scoped read sites in `mails/imap.ts` join this mapping
 * instead of reading `mails.uid_account` directly. Rows written by
 * `saveMail` / `storeMail` (PR 2a) already have their mapping; mail
 * that predates that PR does not — this helper backfills those on
 * first access.
 *
 * Backfill shape: copy the mail's existing `uid_account` verbatim. The
 * UID was already reserved from `mail_uid_counters` at receive time, so
 * mirroring it preserves the per-account UID sequence without burning a
 * fresh counter tick. `ON CONFLICT DO NOTHING` makes a concurrent
 * ensureMailboxUids call idempotent — the loser reads the winner's row
 * on the second SELECT.
 *
 * Filters `uid_account > 0` so mails that were never assigned an
 * account UID (domain-only rows on a legacy path) don't emit a
 * zero-UID mapping. Callers that only need domain UIDs skip this
 * helper entirely.
 */
export const ensureMailboxUids = async (
  user_id: string,
  mailbox: string,
  mail_ids: string[]
): Promise<Map<string, number>> => {
  const result = new Map<string, number>();
  if (mail_ids.length === 0) return result;

  // Backfill missing rows in one round-trip. INSERT … SELECT lets
  // Postgres do the "for each mail without a mapping, copy its
  // uid_account" work server-side; the anti-join (`WHERE NOT EXISTS`)
  // narrows to the missing set.
  const backfillSql = `
    INSERT INTO ${MAIL_MAILBOX_UID} (${USER_ID}, ${MAILBOX}, ${MAIL_ID}, ${UID})
    SELECT m.user_id, $2, m.mail_id, m.uid_account
    FROM mails m
    WHERE m.user_id = $1
      AND m.mail_id = ANY($3::text[])
      AND m.uid_account > 0
      AND NOT EXISTS (
        SELECT 1 FROM ${MAIL_MAILBOX_UID} x
        WHERE x.${USER_ID} = m.user_id
          AND x.${MAILBOX} = $2
          AND x.${MAIL_ID} = m.mail_id
      )
    ON CONFLICT (${USER_ID}, ${MAILBOX}, ${MAIL_ID}) DO NOTHING
  `;
  try {
    await pool.query(backfillSql, [user_id, mailbox, mail_ids]);
  } catch (error) {
    logger.warn(
      "ensureMailboxUids backfill failed — proceeding with best-effort read",
      { user_id, mailbox, mail_id_count: mail_ids.length },
      error
    );
  }

  // Read the complete set — includes rows PR 2a wrote at insert time,
  // plus any rows the backfill above just created (or the concurrent
  // caller's winner rows). Empty result for a given mail_id means it
  // has no `uid_account` at all (never routed through an account UID
  // space) — the caller filters those out via its own address
  // predicate before they reach here.
  try {
    const rows = await pool.query<{ mail_id: string; uid: number }>(
      `SELECT ${MAIL_ID} AS mail_id, ${UID} AS uid
       FROM ${MAIL_MAILBOX_UID}
       WHERE ${USER_ID} = $1 AND ${MAILBOX} = $2 AND ${MAIL_ID} = ANY($3::text[])`,
      [user_id, mailbox, mail_ids]
    );
    for (const row of rows.rows) {
      result.set(row.mail_id, Number(row.uid));
    }
  } catch (error) {
    logger.error(
      "ensureMailboxUids read failed",
      { user_id, mailbox, mail_id_count: mail_ids.length },
      error
    );
  }
  return result;
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
 * any message routed to it. Computed on demand as `MAX(modseq)` over the same
 * mailbox-routing predicate the UID queries use (option (a) from #607); no
 * materialized per-mailbox counter, so nothing to keep in sync on every write.
 *
 * Expunged rows are INTENTIONALLY included: an EXPUNGE bumps a message's modseq
 * before it vanishes, and HIGHESTMODSEQ must reflect that so a resyncing client
 * (QRESYNC, later phases) detects the removal. Returns 1 for an empty mailbox
 * (the DEFAULT-1 floor), never 0 — a 0 HIGHESTMODSEQ signals "no persistent
 * mod-sequences", which this store does support.
 */
export const getHighestModseq = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<number> => {
  try {
    let sql: string;
    let values: ParamValue[];
    if (account === null) {
      sql = `
        SELECT COALESCE(MAX(${MODSEQ}), 1) AS highest FROM mails
        WHERE ${USER_ID} = $1 AND ${SENT} = $2
      `;
      values = [user_id, sent];
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      sql = `
        SELECT COALESCE(MAX(${MODSEQ}), 1) AS highest FROM mails
        WHERE ${USER_ID} = $1 AND ${SENT} = $2 AND ${addressCondition}
      `;
      values = [user_id, sent, addressJson];
    }
    const result = await pool.query(sql, values);
    return parseInt(result.rows[0]?.highest ?? "1", 10);
  } catch (error) {
    logger.error("Failed to get highest modseq", {}, error);
    return 1;
  }
};
