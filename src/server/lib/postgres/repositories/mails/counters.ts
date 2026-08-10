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

/**
 * Build the non-allocating counterpart of `buildReserveUidQuery`: read what the
 * NEXT reservation would return, without consuming it. This is UIDNEXT
 * (RFC 3501 §2.3.1.1), which must exceed every UID ever assigned in the scope
 * and must never decrease — so it has to come from the counter that actually
 * assigns UIDs, not from a `MAX(uid)` over surviving rows (a `MAX` drops the
 * moment the highest-UID mail is expunged or hard-deleted; see #743).
 *
 * `COALESCE` covers the pre-reservation state: a scope whose counter row does
 * not exist yet answers with the very `seedSql` the first reservation would
 * insert, so a peek and the allocation it predicts can never disagree. Same
 * placeholder layout as the reservation ($1 user, $2 kind, $3 scope, $4 sent,
 * $5… seed params) so `seedSql` is reused verbatim.
 */
const buildPeekUidNextQuery = (
  user_id: string,
  kind: string,
  scope: string,
  sent: boolean,
  seedSql: string,
  seedParams: ParamValue[]
): { sql: string; values: ParamValue[] } => {
  const sql = `
    SELECT COALESCE(
      (
        SELECT ${LAST_UID} + 1 FROM ${MAIL_UID_COUNTERS}
        WHERE ${USER_ID} = $1 AND ${UID_KIND} = $2
          AND ${UID_SCOPE} = $3 AND ${SENT} = $4
      ),
      (${seedSql})
    ) AS uid_next
  `;
  return { sql, values: [user_id, kind, scope, sent, ...seedParams] };
};

/** Seed for the domain-wide sequence — shared by the reservation and the peek. */
const domainSeed = (): { sql: string; params: ParamValue[] } => ({
  sql: `
      SELECT COALESCE(MAX(${UID_DOMAIN}), 0) + 1 FROM mails
      WHERE ${USER_ID} = $1 AND ${SENT} = $4
    `,
  params: [],
});

/** Domain-wide UID-reservation query (kind="domain", no scope). */
export const buildDomainUidQuery = (
  user_id: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const seed = domainSeed();
  return buildReserveUidQuery(user_id, "domain", "", sent, seed.sql, seed.params);
};

/** Domain-wide UIDNEXT peek — same counter row as `buildDomainUidQuery`. */
export const buildDomainUidNextQuery = (
  user_id: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const seed = domainSeed();
  return buildPeekUidNextQuery(user_id, "domain", "", sent, seed.sql, seed.params);
};

/**
 * Seed for a per-account sequence — shared by the reservation and the peek.
 *
 * Sources from `mail_mailbox_uid.uid` — the authoritative per-mailbox UID
 * store after #702 PR 3 dropped `mails.uid_account`. The tuple predicate
 * matches any of the mailbox paths that the write side derives from
 * (address, sent): the per-account paths `INBOX/accounts/<local>` and
 * `Sent Messages/accounts/<local>`, plus the raw local part for
 * user-created mailboxes (`Archive` etc., where `boxToAccount` returns
 * `<name>@<domain>` and the write side stores the box name unchanged).
 * All three shapes coexist inside `mail_mailbox_uid.mailbox`; the
 * OR-union covers each with one indexed lookup.
 *
 * In practice the RESERVATION evaluates this only on the very first call for
 * a (user, address, sent) triple — every subsequent call takes the DO UPDATE
 * branch and doesn't re-evaluate it. Existing deployments already have counter
 * rows for every mailbox that has ever received a mail, so the seed's specific
 * value only matters for the exact new-mailbox-with-pre-existing-rows edge
 * (nonexistent under any real write path but defended against for
 * hostile-data safety). The PEEK evaluates it on the same condition — no
 * counter row yet — and gets the identical answer by construction.
 */
const accountSeed = (
  account: string,
  sent: boolean
): { sql: string; params: ParamValue[] } => {
  const localPart = account.split("@")[0];
  const perAccountPath = sent
    ? `Sent Messages/accounts/${localPart}`
    : `INBOX/accounts/${localPart}`;
  return {
    sql: `
      SELECT COALESCE(MAX(${UID}), 0) + 1 FROM ${MAIL_MAILBOX_UID}
      WHERE ${USER_ID} = $1
        AND ${MAILBOX} IN ($5, $6)
    `,
    params: [perAccountPath, localPart],
  };
};

/** Per-account UID-reservation query (kind="account", scope=address). */
export const buildAccountUidQuery = (
  user_id: string,
  account: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const seed = accountSeed(account, sent);
  return buildReserveUidQuery(user_id, "account", account, sent, seed.sql, seed.params);
};

/** Per-account UIDNEXT peek — same counter row as `buildAccountUidQuery`. */
export const buildAccountUidNextQuery = (
  user_id: string,
  account: string,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const seed = accountSeed(account, sent);
  return buildPeekUidNextQuery(user_id, "account", account, sent, seed.sql, seed.params);
};

export const buildMailboxUidQuery = (
  user_id: string,
  mailbox: string
): { sql: string; values: ParamValue[] } => {
  const seedSql = `
      SELECT COALESCE(MAX(${UID}), 0) + 1 FROM ${MAIL_MAILBOX_UID}
      WHERE ${USER_ID} = $1 AND ${MAILBOX} = $5
    `;
  return buildReserveUidQuery(user_id, "mailbox", mailbox, false, seedSql, [mailbox]);
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
 * Reserve the next UID for a mapped-utility mailbox (`Starred`, `Trash`).
 * Callers pass the literal box name — the same string persisted in
 * `mail_mailbox_uid.mailbox`. Not for per-account boxes: those still route
 * through `getAccountUidNext` because their sent/received halves are
 * DIFFERENT mailboxes and legitimately share the UID number space.
 */
export const getMailboxUidNext = async (
  user_id: string,
  mailbox: string
): Promise<number> => {
  try {
    return await reserveNextUid(buildMailboxUidQuery(user_id, mailbox));
  } catch (error) {
    logger.error("Error getting mailbox UID next", { mailbox }, error);
    throw error;
  }
};

/**
 * UIDNEXT for a mailbox (RFC 3501 §2.3.1.1) WITHOUT allocating a UID — what
 * `getDomainUidNext` / `getAccountUidNext` would hand out next. `account` is
 * the box's account address, or `null` for the two domain-scoped views
 * (INBOX, unified Sent Messages), mirroring `Store.resolveBox`.
 *
 * Reading the counter rather than `MAX(uid)` over live rows is the whole point
 * (#743): a `MAX` decreases when the highest-UID mail is expunged or hard
 * deleted, which the RFC forbids and which re-promises a UID the counter has
 * already handed out.
 *
 * THROWS on a DB fault instead of returning a floor. A fabricated-low UIDNEXT
 * is the exact corruption this removes, and every caller (SELECT / EXAMINE /
 * STATUS) already turns a throw into a retry-friendly tagged `NO … failed`
 * rather than a permanent-sounding wrong answer — same reasoning as #601.
 */
export const getUidNext = async (
  user_id: string,
  account: string | null,
  sent: boolean = false
): Promise<number> => {
  try {
    const query =
      account === null
        ? buildDomainUidNextQuery(user_id, sent)
        : buildAccountUidNextQuery(user_id, account, sent);
    const result = await pool.query(query.sql, query.values);
    return parseInt(result.rows[0]?.uid_next || "1", 10);
  } catch (error) {
    logger.error("Error reading UIDNEXT", {}, error);
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
/**
 * Drop a `mail_mailbox_uid` mapping row. Used by the mapped-utility flag hook
 * (see `syncMailboxPivot`): a STORE that clears `\Flagged` on a starred mail
 * has to remove its `Starred` pivot so the utility view stops surfacing it.
 * Idempotent — a delete against a non-existent pivot is a legal no-op.
 *
 * Not a substitute for `expungeMailsByUid` on a mapped destination: expunge
 * flips `mails.expunged = TRUE` and keeps the pivot so the mailbox's UID
 * sequence stays intact (RFC 3501 §2.3.1.1). This drops the pivot outright,
 * so the UID it held is retired forever — a re-star draws a fresh higher UID
 * from `getMailboxUidNext`, which is exactly what the RFC requires.
 */
export const deleteMailboxUid = async (
  user_id: string,
  mailbox: string,
  mail_id: string
): Promise<void> => {
  try {
    await pool.query(
      `DELETE FROM ${MAIL_MAILBOX_UID}
       WHERE ${USER_ID} = $1 AND ${MAILBOX} = $2 AND ${MAIL_ID} = $3`,
      [user_id, mailbox, mail_id]
    );
  } catch (error) {
    logger.error(
      "Failed to delete mail_mailbox_uid mapping",
      { user_id, mailbox, mail_id },
      error
    );
    throw error;
  }
};

/**
 * Mirror a mail's mapped-utility membership flag into `mail_mailbox_uid`.
 * The pivot table for a mapped-utility folder (`Starred`, `Trash`) has to
 * agree with the corresponding `mails` flag (`saved`, `deleted`) — the view
 * shows exactly the mails with a pivot row, so a divergence is a mail
 * visible in one surface (web / flag) and invisible in the other (IMAP /
 * pivot). Called from every path that flips the flag: `setMailFlags`
 * (IMAP STORE), `markMailSaved` (HTTP /mark), and future writers.
 *
 * `isPresent` names the target state, not the delta — the caller passes the
 * post-write flag value from `mails.saved` / `mails.deleted`, and this
 * either inserts (writeMailboxUid ON CONFLICT DO NOTHING via DO UPDATE that
 * keeps the existing uid) or deletes to match. Both branches are idempotent,
 * so a repeat STORE that doesn't change the flag stays cheap.
 */
export const syncMailboxPivot = async (
  user_id: string,
  mailbox: string,
  mail_id: string,
  isPresent: boolean
): Promise<void> => {
  if (isPresent) {
    // Reserve a fresh mailbox UID and try to insert. If the pivot already
    // exists (this STORE was a no-op re-star), writeMailboxUid's
    // ON CONFLICT DO UPDATE keeps the old uid and the reservation is
    // wasted — cheap, and preserves UID monotonicity for the case that
    // matters: unstar-then-restar draws a NEW higher uid, per RFC.
    const uid = await getMailboxUidNext(user_id, mailbox);
    await writeMailboxUid(user_id, mailbox, mail_id, uid);
  } else {
    await deleteMailboxUid(user_id, mailbox, mail_id);
  }
};

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
