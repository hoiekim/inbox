import { ParamValue } from "../../database";
import {
  MAIL_ID,
  USER_ID,
  UID_DOMAIN,
  MODSEQ,
  SENT,
  EXPUNGED,
  MAIL_MAILBOX_UID,
  MAILBOX,
  UID,
} from "../../models";
import {
  filtersMembership,
  membershipCondition,
  membershipExpression,
  usesDomainUidSpace,
} from "./views";

export interface SetMailFlagsQueries {
  selectSql: string;
  /**
   * The same match as `selectSql`, projecting only `uid`. The conditional
   * path reads it purely to diff matched against updated, so a `UID STORE 1:*`
   * over a large mailbox has no reason to materialize eight flag columns per
   * row.
   */
  matchedUidSql: string;
  updateSql: string;
  /**
   * The values bound ahead of the two the caller appends: the freshly
   * reserved mod-sequence, then the UNCHANGEDSINCE ceiling when `conditional`.
   * So the stamped placeholder is `$(baseValues.length + 1)` and the guard is
   * one past it — the invariant every branch below has to keep.
   */
  baseValues: ParamValue[];
}

/**
 * The SELECT / UPDATE pair one STORE runs, built without touching the pool so
 * the parameter numbering can be asserted directly.
 *
 * ```ts
 * const { selectSql, updateSql, baseValues } = buildSetMailFlagsQueries(...);
 * await pool.query(updateSql, [...baseValues, modseq, unchangedSince]);
 * ```
 */
export const buildSetMailFlagsQueries = (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  setClause: string,
  conditional: boolean
): SetMailFlagsQueries => {
  // Two flavors of query — domain-scoped stays on `mails.uid_domain`,
  // per-mailbox joins `mail_mailbox_uid`. RETURNING clauses select
  // the appropriate UID and the shared flag/modseq columns.
  let selectSql: string;
  let matchedUidSql: string;
  let updateSql: string;
  let baseValues: ParamValue[];

  // A STORE addresses messages *in the selected mailbox*, so it has to see
  // the same set the reads do — otherwise `UID STORE 1:* +FLAGS (\Deleted)`
  // on INBOX would flag quarantined spam the client was never shown, and the
  // following EXPUNGE would destroy it.
  const membership = membershipCondition(mailbox, sent);

  if (usesDomainUidSpace(mailbox)) {
    const returningCols = `${MAIL_ID}, ${UID_DOMAIN} as uid, read, saved, deleted, draft, answered, ${MODSEQ} as modseq`;
    const uidCol = `${UID_DOMAIN} as uid`;
    if (useUid) {
      const whereClause = `user_id = $1 AND sent = $2 AND ${UID_DOMAIN} >= $3 AND ${UID_DOMAIN} <= $4${membership}`;
      selectSql = `SELECT ${returningCols} FROM mails WHERE ${whereClause}`;
      matchedUidSql = `SELECT ${uidCol} FROM mails WHERE ${whereClause}`;
      updateSql = `UPDATE mails
        SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $5
        WHERE ${whereClause}${conditional ? ` AND ${MODSEQ} <= $6` : ""}
        RETURNING ${returningCols}`;
      baseValues = [user_id, sent, start, end];
    } else {
      const whereClause = `mail_id IN (
        SELECT mail_id FROM mails
        WHERE user_id = $1 AND sent = $2${membership}
        ORDER BY ${UID_DOMAIN} ASC
        OFFSET $3 LIMIT 1
      )`;
      selectSql = `SELECT ${returningCols} FROM mails WHERE ${whereClause}`;
      matchedUidSql = `SELECT ${uidCol} FROM mails WHERE ${whereClause}`;
      updateSql = `UPDATE mails
        SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $4
        WHERE ${whereClause}${conditional ? ` AND ${MODSEQ} <= $5` : ""}
        RETURNING ${returningCols}`;
      baseValues = [user_id, sent, start];
    }
  } else {
    // Per-mailbox: JOIN `mail_mailbox_uid` for both membership and UID.
    // RETURNING `x.uid` — the mailbox-specific UID the client sees, and the
    // mapping table is its sole source.
    const returningCols = `m.${MAIL_ID}, x.${UID} as uid, m.read, m.saved, m.deleted, m.draft, m.answered, m.${MODSEQ} as modseq`;
    const uidCol = `x.${UID} as uid`;
    if (useUid) {
      const whereClause = `m.${USER_ID} = $1 AND m.${SENT} = $2
        AND x.${USER_ID} = m.${USER_ID} AND x.${MAILBOX} = $3 AND x.${MAIL_ID} = m.${MAIL_ID}
        AND x.${UID} >= $4 AND x.${UID} <= $5${membershipCondition(mailbox, sent, "m.")}`;
      selectSql = `SELECT ${returningCols} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
      matchedUidSql = `SELECT ${uidCol} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
      // UPDATE ... FROM syntax joins the mapping to the target mails
      // rows. Postgres semantics: rows matching the join get updated
      // once. RETURNING refers to columns from either side.
      updateSql = `UPDATE mails m
        SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $6
        FROM ${MAIL_MAILBOX_UID} x
        WHERE ${whereClause}${conditional ? ` AND m.${MODSEQ} <= $7` : ""}
        RETURNING ${returningCols}`;
      baseValues = [user_id, sent, mailbox, start, end];
    } else {
      // Sequence-number path: match a single row at the OFFSETth
      // position in the mailbox's UID-ordered list.
      // A sequence number counts only the messages the mailbox shows, so this
      // OFFSET has to walk the same list `getAllUids` builds — which means
      // `sent` and `expunged` too, not just the membership rule: mapping rows
      // outlive the expunge that hid their mail, so a mapping-only scan
      // counts messages the seq map does not and shifts every position after
      // them. The join is emitted only for a box that filters; every other
      // box keeps the mapping-only scan it had.
      const membershipJoin = filtersMembership(mailbox, sent)
        ? `JOIN mails z ON z.${USER_ID} = y.${USER_ID} AND z.${MAIL_ID} = y.${MAIL_ID}
           AND z.${SENT} = $2 AND z.${EXPUNGED} = FALSE
           AND ${membershipExpression(mailbox, sent, "z.")}`
        : "";
      const targetSubquery = `(
        SELECT y.${MAIL_ID} FROM ${MAIL_MAILBOX_UID} y
        ${membershipJoin}
        WHERE y.${USER_ID} = $1 AND y.${MAILBOX} = $3
        ORDER BY y.${UID} ASC
        OFFSET $4 LIMIT 1
      )`;
      const whereClause = `m.${USER_ID} = $1 AND m.${SENT} = $2
        AND x.${USER_ID} = m.${USER_ID} AND x.${MAILBOX} = $3 AND x.${MAIL_ID} = m.${MAIL_ID}
        AND m.${MAIL_ID} IN ${targetSubquery}`;
      selectSql = `SELECT ${returningCols} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
      matchedUidSql = `SELECT ${uidCol} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
      updateSql = `UPDATE mails m
        SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $5
        FROM ${MAIL_MAILBOX_UID} x
        WHERE ${whereClause}${conditional ? ` AND m.${MODSEQ} <= $6` : ""}
        RETURNING ${returningCols}`;
      baseValues = [user_id, sent, mailbox, start];
    }
  }

  return { selectSql, matchedUidSql, updateSql, baseValues };
};
