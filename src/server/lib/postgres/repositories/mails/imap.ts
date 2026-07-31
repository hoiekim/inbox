import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import {
  PartialMailModel,
  mailsTable,
  MAIL_ID,
  USER_ID,
  UID_DOMAIN,
  MODSEQ,
  SENT,
  DELETED,
  EXPUNGED,
  DB_NOW,
  MAIL_MAILBOX_UID,
  MAILBOX,
  UID,
} from "../../models";
import { getNextModseq } from "./counters";
import { singleFlight } from "./inflight";

/**
 * Callers pass `mailbox` as the raw IMAP box path (e.g. `INBOX/accounts/amazon`,
 * `Sent Messages/accounts/claoie`, or a user-created box like `Archive`) — the
 * exact string the write side stores in `mail_mailbox_uid.mailbox`. `null` is
 * reserved for domain-scoped views (`INBOX`, unified `Sent Messages`), which
 * stay on `mails.uid_domain` and don't participate in the per-mailbox mapping.
 */

export const countMessages = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Promise<{ total: number; unread: number; maxUid: number }> => {
  try {
    let sql: string;
    let values: ParamValue[];

    if (mailbox === null) {
      // Domain-wide count (INBOX / unified Sent Messages) — still keyed on
      // uid_domain, unchanged by #702's per-mailbox mapping migration.
      sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
          COALESCE(MAX(${UID_DOMAIN}), 0) as max_uid
        FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
      `;
      values = [user_id, sent];
    } else {
      // Per-mailbox view — the `mail_mailbox_uid` mapping is the
      // authoritative membership + UID source. INNER JOIN encodes both:
      // a row exists iff the mail is in this mailbox, and its `uid`
      // column is the per-mailbox UID the client sees. Legacy mails
      // that predate the write-side dual-write (pre-#615) and never got
      // backfilled — e.g. the 140 rows the one-shot script skipped over
      // duplicate-UID collisions from a #617-era race — have no mapping
      // row and are intentionally invisible to reads.
      sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN m.read = FALSE THEN 1 ELSE 0 END) as unread,
          COALESCE(MAX(x.${UID}), 0) as max_uid
        FROM mails m
        JOIN ${MAIL_MAILBOX_UID} x
          ON x.${USER_ID} = m.${USER_ID}
          AND x.${MAILBOX} = $3
          AND x.${MAIL_ID} = m.${MAIL_ID}
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE
      `;
      values = [user_id, sent, mailbox];
    }

    const result = await pool.query(sql, values);
    return {
      total: parseInt(result.rows[0]?.total || "0", 10),
      unread: parseInt(result.rows[0]?.unread || "0", 10),
      maxUid: parseInt(result.rows[0]?.max_uid || "0", 10),
    };
  } catch (error) {
    logger.error("Failed to count messages", {}, error);
    return { total: 0, unread: 0, maxUid: 0 };
  }
};

/**
 * IMAP-facing range read over the `mails` table.
 *
 * **Return-value sharing.** Coalesced callers (see below) receive the SAME
 * `Map` reference AND the same `PartialMailModel` instances. Do not mutate
 * either — treat the return as read-only. Load-bearing for the memory
 * property below.
 *
 * **Single-flight coalescing.** Concurrent identical calls (same key: user
 * + account + sent + range + field-set) share one in-flight promise. A
 * misbehaving IMAP client that pipelines duplicate `UID FETCH <UID> BODY`
 * requests would otherwise trigger N concurrent SQL loads of the same
 * multi-MB body, multiplying container RSS by concurrent-inflight-count
 * (the OOM path). Memory footprint is now
 * `O(distinct-in-flight-queries)` instead of `O(callers)`.
 *
 * Key sorts the field list so different argument-order variants collapse
 * to the same key — strict-subset field lists intentionally do NOT
 * coalesce (different SELECT projections → different rows to construct
 * `PartialMailModel` from).
 */
export const getMailsByRange = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[] = ["*"]
): Promise<Map<string, PartialMailModel>> => {
  const sortedFields = [...fields].sort();
  const inflightKey = JSON.stringify([
    user_id,
    mailbox,
    sent,
    start,
    end,
    useUid,
    sortedFields,
  ]);
  return singleFlight(inflightKey, () => getMailsByRangeUncoalesced(
    user_id, mailbox, sent, start, end, useUid, fields
  ));
};

const getMailsByRangeUncoalesced = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[]
): Promise<Map<string, PartialMailModel>> => {
  try {
    let sql: string;
    let values: ParamValue[];

    // Validate and resolve the field list.
    // "*" expands to all valid MailModel columns; otherwise each field is validated.
    const isSelectAll = fields.length === 1 && fields[0] === "*";
    const resolvedFields = isSelectAll
      ? [...PartialMailModel.validFields]
      : fields;
    // Validate field names up-front so bad requests fail fast
    const unknownFields = resolvedFields.filter(
      (f) => !PartialMailModel.validFields.has(f)
    );
    if (unknownFields.length > 0) {
      logger.warn("getMailsByRange: unknown fields requested", {
        unknownFields,
      });
    }
    const safeFields = resolvedFields.filter((f) =>
      PartialMailModel.validFields.has(f)
    );
    // Always include mail_id — it is the Map key; without it all rows collapse to key=undefined
    if (!safeFields.includes("mail_id")) {
      safeFields.unshift("mail_id");
    }
    // Synthetic PartialMailModel fields are not `mails` columns (see
    // mail.ts:partialSyntheticFieldCheckers) — each has its own projection
    // rule. `uid_mailbox` aliases the JOIN's per-mailbox UID (or `uid_domain`
    // for domain-scoped views). `text_octets` / `html_octets` project
    // `octet_length()` of the respective TEXT column so a stream caller can
    // pre-measure the `{N}` literal without loading the body. Strip these
    // names from the mails-side SELECT list so they never appear as literal
    // column references.
    const wantsUidMailbox = safeFields.includes("uid_mailbox");
    const wantsTextOctets = safeFields.includes("text_octets");
    const wantsHtmlOctets = safeFields.includes("html_octets");
    const syntheticNames = new Set(["uid_mailbox", "text_octets", "html_octets"]);
    const mailsColumns = safeFields.filter((f) => !syntheticNames.has(f));

    const octetProjections = (prefix: string): string => {
      const parts: string[] = [];
      if (wantsTextOctets) parts.push(`octet_length(${prefix}text) AS text_octets`);
      if (wantsHtmlOctets) parts.push(`octet_length(${prefix}html) AS html_octets`);
      return parts.length ? ", " + parts.join(", ") : "";
    };

    if (mailbox === null) {
      // Domain-wide query (INBOX / unified Sent Messages) — still on
      // uid_domain, unchanged by the per-mailbox mapping migration.
      const projection = mailsColumns.length > 0 ? mailsColumns.join(", ") : "*";
      const uidMailboxAlias = wantsUidMailbox
        ? `, ${UID_DOMAIN} AS uid_mailbox`
        : "";
      const fieldList = `${projection}${uidMailboxAlias}${octetProjections("")}`;
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails
          WHERE user_id = $1 AND sent = $2 AND ${UID_DOMAIN} >= $3 AND ${UID_DOMAIN} <= $4
            AND expunged = FALSE
          ORDER BY ${UID_DOMAIN} ASC
        `;
        values = [user_id, sent, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails
          WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
          ORDER BY ${UID_DOMAIN} ASC
          OFFSET $3 LIMIT $4
        `;
        values = [user_id, sent, start - 1, end - start + 1];
      }
    } else {
      // Per-mailbox query — JOIN `mail_mailbox_uid` to fetch the
      // mailbox-specific UID and enforce membership. Fields on `mails`
      // are prefixed with `m.` so the SELECT is unambiguous across the
      // join. `uid_mailbox` is emitted as `x.uid AS uid_mailbox` when
      // requested — the per-mailbox UID the client sees.
      const qualifiedFields = mailsColumns
        .map((f) => `m.${f}`)
        .join(", ");
      const uidMailboxAlias = wantsUidMailbox
        ? `${qualifiedFields ? ", " : ""}x.${UID} AS uid_mailbox`
        : "";
      const octetsFragment = octetProjections("m.");
      const fieldList =
        qualifiedFields.length + uidMailboxAlias.length + octetsFragment.length > 0
          ? `${qualifiedFields}${uidMailboxAlias}${octetsFragment}`
          : "m.*";
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails m
          JOIN ${MAIL_MAILBOX_UID} x
            ON x.${USER_ID} = m.${USER_ID}
            AND x.${MAILBOX} = $3
            AND x.${MAIL_ID} = m.${MAIL_ID}
          WHERE m.${USER_ID} = $1 AND m.${SENT} = $2
            AND x.${UID} >= $4 AND x.${UID} <= $5
            AND m.${EXPUNGED} = FALSE
          ORDER BY x.${UID} ASC
        `;
        values = [user_id, sent, mailbox, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails m
          JOIN ${MAIL_MAILBOX_UID} x
            ON x.${USER_ID} = m.${USER_ID}
            AND x.${MAILBOX} = $3
            AND x.${MAIL_ID} = m.${MAIL_ID}
          WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE
          ORDER BY x.${UID} ASC
          OFFSET $4 LIMIT $5
        `;
        values = [user_id, sent, mailbox, start - 1, end - start + 1];
      }
    }

    const result = await pool.query(sql, values);
    const mails = new Map<string, PartialMailModel>();
    for (const row of result.rows) {
      mails.set(row.mail_id, new PartialMailModel(safeFields, row));
    }
    return mails;
  } catch (error) {
    logger.error("Failed to get mails by range", {}, error);
    return new Map();
  }
};

export interface UpdatedMailFlags {
  uid: number;
  read: boolean;
  saved: boolean;
  deleted: boolean;
  draft: boolean;
  answered: boolean;
  // The mod-sequence stamped by this STORE (shared across every row it matched).
  // Backs the MODSEQ item on the untagged FETCH a CONDSTORE client gets from a
  // flag change (RFC 4551 §3.3.2).
  modseq: number;
}

/**
 * Operation type for STORE command per RFC 3501
 * - "FLAGS" or "FLAGS.SILENT": Replace all flags with the provided flags
 * - "+FLAGS" or "+FLAGS.SILENT": Add the provided flags (leave others unchanged)
 * - "-FLAGS" or "-FLAGS.SILENT": Remove the provided flags (leave others unchanged)
 */
export type StoreOperationType = "FLAGS" | "+FLAGS" | "-FLAGS";

/**
 * Build the `SET`-column assignments for a flag update, per RFC 3501 §6.4.6:
 * - FLAGS: replace all flags with the provided list
 * - +FLAGS: add the specified flags to existing flags
 * - -FLAGS: remove the specified flags from existing flags
 *
 * Returns `""` when the operation touches no recognized flag — an empty
 * `+FLAGS ()`/`-FLAGS ()` or a list of only non-standard keywords. That is a
 * legal no-op (§6.4.6), which `setMailFlags` serves without an UPDATE.
 */
export function buildFlagSetClause(
  operation: StoreOperationType,
  flags: string[]
): string {
  const hasFlag = (flag: string) => flags.includes(flag);

  switch (operation) {
    case "+FLAGS": {
      // Add mode: only set flags that are in the array to true
      const addClauses: string[] = [];
      if (hasFlag("\\Seen")) addClauses.push("read = TRUE");
      if (hasFlag("\\Flagged")) addClauses.push("saved = TRUE");
      if (hasFlag("\\Deleted")) addClauses.push("deleted = TRUE");
      if (hasFlag("\\Draft")) addClauses.push("draft = TRUE");
      if (hasFlag("\\Answered")) addClauses.push("answered = TRUE");
      return addClauses.join(", ");
    }

    case "-FLAGS": {
      // Remove mode: only set flags that are in the array to false
      const removeClauses: string[] = [];
      if (hasFlag("\\Seen")) removeClauses.push("read = FALSE");
      if (hasFlag("\\Flagged")) removeClauses.push("saved = FALSE");
      if (hasFlag("\\Deleted")) removeClauses.push("deleted = FALSE");
      if (hasFlag("\\Draft")) removeClauses.push("draft = FALSE");
      if (hasFlag("\\Answered")) removeClauses.push("answered = FALSE");
      return removeClauses.join(", ");
    }

    case "FLAGS":
    default:
      // Replace mode: set every flag based on presence in the flags array.
      // Always a full assignment, so never a no-op.
      return `
        read = ${hasFlag("\\Seen")},
        saved = ${hasFlag("\\Flagged")},
        deleted = ${hasFlag("\\Deleted")},
        draft = ${hasFlag("\\Draft")},
        answered = ${hasFlag("\\Answered")}
      `;
  }
}

export const setMailFlags = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  start: number,
  end: number,
  flags: string[],
  useUid: boolean,
  operation: StoreOperationType = "FLAGS"
): Promise<UpdatedMailFlags[]> => {
  try {
    const setClause = buildFlagSetClause(operation, flags);

    // Two flavors of query — domain-scoped stays on `mails.uid_domain`,
    // per-mailbox joins `mail_mailbox_uid`. RETURNING clauses select
    // the appropriate UID and the shared flag/modseq columns.
    let selectSql: string;
    let updateSql: string;
    let baseValues: ParamValue[];

    if (mailbox === null) {
      const returningCols = `${UID_DOMAIN} as uid, read, saved, deleted, draft, answered, ${MODSEQ} as modseq`;
      if (useUid) {
        const whereClause = `user_id = $1 AND sent = $2 AND ${UID_DOMAIN} >= $3 AND ${UID_DOMAIN} <= $4`;
        selectSql = `SELECT ${returningCols} FROM mails WHERE ${whereClause}`;
        updateSql = `UPDATE mails
          SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $5
          WHERE ${whereClause}
          RETURNING ${returningCols}`;
        baseValues = [user_id, sent, start, end];
      } else {
        const whereClause = `mail_id IN (
          SELECT mail_id FROM mails
          WHERE user_id = $1 AND sent = $2
          ORDER BY ${UID_DOMAIN} ASC
          OFFSET $3 LIMIT 1
        )`;
        selectSql = `SELECT ${returningCols} FROM mails WHERE ${whereClause}`;
        updateSql = `UPDATE mails
          SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $4
          WHERE ${whereClause}
          RETURNING ${returningCols}`;
        baseValues = [user_id, sent, start];
      }
    } else {
      // Per-mailbox: JOIN `mail_mailbox_uid` for both membership and
      // UID. RETURNING `x.uid` (the mailbox-specific UID the client sees)
      // — the mapping table is the sole per-mailbox UID source after
      // #702 PR 3 dropped `mails.uid_account`.
      const returningCols = `x.${UID} as uid, m.read, m.saved, m.deleted, m.draft, m.answered, m.${MODSEQ} as modseq`;
      if (useUid) {
        const whereClause = `m.${USER_ID} = $1 AND m.${SENT} = $2
          AND x.${USER_ID} = m.${USER_ID} AND x.${MAILBOX} = $3 AND x.${MAIL_ID} = m.${MAIL_ID}
          AND x.${UID} >= $4 AND x.${UID} <= $5`;
        selectSql = `SELECT ${returningCols} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
        // UPDATE ... FROM syntax joins the mapping to the target mails
        // rows. Postgres semantics: rows matching the join get updated
        // once. RETURNING refers to columns from either side.
        updateSql = `UPDATE mails m
          SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $6
          FROM ${MAIL_MAILBOX_UID} x
          WHERE ${whereClause}
          RETURNING ${returningCols}`;
        baseValues = [user_id, sent, mailbox, start, end];
      } else {
        // Sequence-number path: match a single row at the OFFSETth
        // position in the mailbox's UID-ordered list.
        const targetSubquery = `(
          SELECT y.${MAIL_ID} FROM ${MAIL_MAILBOX_UID} y
          WHERE y.${USER_ID} = $1 AND y.${MAILBOX} = $3
          ORDER BY y.${UID} ASC
          OFFSET $4 LIMIT 1
        )`;
        const whereClause = `m.${USER_ID} = $1 AND m.${SENT} = $2
          AND x.${USER_ID} = m.${USER_ID} AND x.${MAILBOX} = $3 AND x.${MAIL_ID} = m.${MAIL_ID}
          AND m.${MAIL_ID} IN ${targetSubquery}`;
        selectSql = `SELECT ${returningCols} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
        updateSql = `UPDATE mails m
          SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $5
          FROM ${MAIL_MAILBOX_UID} x
          WHERE ${whereClause}
          RETURNING ${returningCols}`;
        baseValues = [user_id, sent, mailbox, start];
      }
    }

    // No recognized flag change (empty `+FLAGS ()` / `-FLAGS ()` or unknown-only
    // keywords): RFC 3501 §6.4.6 makes this a legal no-op. Return the matched
    // rows' CURRENT flags without an UPDATE — a no-op must not bump `updated`
    // (delta-sync cursor) or reserve a new mod-sequence (RFC 7162: modseq only
    // advances when flags actually change).
    if (!setClause) {
      const result = await pool.query(selectSql, baseValues);
      return result.rows.map(toUpdatedMailFlags);
    }

    // One fresh mod-sequence for this STORE, stamped on every matched row so a
    // CONDSTORE client sees one modseq for the whole flag change (RFC 7162 §3.1
    // — a batch mutation may share a single mod-sequence). Reserved atomically so
    // concurrent STOREs get strictly-distinct, monotonic values.
    const modseq = await getNextModseq(user_id);
    const result = await pool.query(updateSql, [...baseValues, modseq]);
    return result.rows.map(toUpdatedMailFlags);
  } catch (error) {
    logger.error("Failed to set mail flags", {}, error);
    return [];
  }
};

const toUpdatedMailFlags = (row: Record<string, unknown>): UpdatedMailFlags => ({
  uid: row.uid as number,
  read: row.read as boolean,
  saved: row.saved as boolean,
  deleted: row.deleted as boolean,
  draft: row.draft as boolean,
  answered: row.answered as boolean,
  // INT8 arrives already numeric via the pool's type parser (client.ts); Number
  // is a no-op today, robust if that parser is ever removed.
  modseq: Number(row.modseq),
});

/**
 * SQL fragment for a criterion the backend cannot express as a real predicate,
 * but which the RFC 3501 §6.4.4 semantics say matches NO message (e.g. KEYWORD
 * when no custom keywords are stored). Emitting a literal `FALSE` fails the
 * search CLOSED — the safe direction — instead of dropping the criterion, which
 * would leave it out of the WHERE clause and match every message (fail-open).
 */
export const MATCH_NONE = "FALSE";

/**
 * Builds the SQL boolean fragment for a single IMAP SEARCH criterion, pushing any
 * bound parameters onto `values` (1-indexed `$N` placeholders track `values.length`).
 * Three-valued: returns a constraint string, `null` for criteria that impose no
 * constraint (match-all: ALL, UNKEYWORD, unsupported combinator operands), or the
 * `MATCH_NONE` sentinel for criteria that can match nothing (KEYWORD, and any key
 * the backend can't express — failing closed per #672). NOT/OR recurse so negation
 * and disjunction compose the three values correctly instead of falling through and
 * matching every message. The caller drops `null` fragments and keeps `MATCH_NONE`
 * (a valid SQL boolean) so the enclosing AND collapses to the empty set.
 */
export const buildCriterionClause = (
  criterion: { type: string; value?: unknown },
  uidField: string,
  values: ParamValue[]
): string | null => {
  const type = criterion.type.toUpperCase();
  switch (type) {
    // Logical operators — recurse into operands carried on `value`.
    // Recursion pushes bound params onto the shared `values` as a side effect,
    // so whenever a reduction DISCARDS a recursed fragment (rather than emitting
    // it), it must roll `values` back to the pre-recursion length — otherwise the
    // discarded side's params are orphaned (present in `values`, referenced by no
    // `$N`), desyncing the count and making Postgres reject the whole Bind.
    case "NOT": {
      const savedLen = values.length;
      const inner = buildCriterionClause(
        criterion.value as { type: string; value?: unknown },
        uidField,
        values
      );
      // NOT match-all → match-none; NOT match-none → match-all; else negate.
      // Both non-negating outcomes discard `inner`, so drop any params it pushed.
      if (inner === null) {
        values.length = savedLen;
        return MATCH_NONE;
      }
      if (inner === MATCH_NONE) {
        values.length = savedLen;
        return null;
      }
      return `NOT (${inner})`;
    }
    case "OR": {
      const { left, right } = criterion.value as {
        left: { type: string; value?: unknown };
        right: { type: string; value?: unknown };
      };
      const savedLen = values.length;
      const l = buildCriterionClause(left, uidField, values);
      const r = buildCriterionClause(right, uidField, values);
      // An OR with a match-all (null) side matches everything → match-all. Both
      // fragments are discarded, so roll `values` back to before this OR.
      if (l === null || r === null) {
        values.length = savedLen;
        return null;
      }
      // Both sides match nothing → match-none (neither pushed a param). Otherwise
      // OR-with-match-none reduces to the other side (`X OR none` = `X`); the
      // match-none side pushed nothing, so the kept side's params stay aligned.
      if (l === MATCH_NONE && r === MATCH_NONE) {
        values.length = savedLen;
        return MATCH_NONE;
      }
      if (l === MATCH_NONE) return r;
      if (r === MATCH_NONE) return l;
      return `(${l} OR ${r})`;
    }

    // ALL: match everything — no additional condition needed
    case "ALL":
      return null;

    // Flag / status criteria
    case "UNSEEN":
      return "read = FALSE";
    case "SEEN":
      return "read = TRUE";
    case "FLAGGED":
      return "saved = TRUE";
    case "UNFLAGGED":
      return "saved = FALSE";
    // ANSWERED / DELETED / DRAFT are tracked as real boolean columns on the
    // mails table (added upstream); map each to its schema column directly.
    case "ANSWERED":
      return "answered = TRUE";
    case "UNANSWERED":
      return "answered = FALSE";
    case "DELETED":
      return "deleted = TRUE";
    case "UNDELETED":
      return "deleted = FALSE";
    case "DRAFT":
      return "draft = TRUE";
    case "UNDRAFT":
      return "draft = FALSE";
    // NEW = RECENT + UNSEEN; RECENT / OLD: not tracked, treat as ALL
    case "NEW":
      return "read = FALSE";
    case "OLD":
    case "RECENT":
      return null; // no \Recent flag tracking; match all

    // Text search criteria
    case "SUBJECT":
      values.push(`%${criterion.value}%`);
      return `subject ILIKE $${values.length}`;
    case "FROM":
      values.push(`%${criterion.value}%`);
      return `from_text ILIKE $${values.length}`;
    case "TO":
      values.push(`%${criterion.value}%`);
      return `to_text ILIKE $${values.length}`;
    case "CC":
      values.push(`%${criterion.value}%`);
      return `cc_text ILIKE $${values.length}`;
    case "BCC":
      values.push(`%${criterion.value}%`);
      return `bcc_text ILIKE $${values.length}`;
    // RFC 3501 §6.4.4: BODY matches the message body; TEXT matches header + body.
    case "BODY": {
      values.push(`%${criterion.value}%`);
      return `text ILIKE $${values.length}`;
    }
    case "TEXT":
    case "SUBJECT_TEXT": {
      values.push(`%${criterion.value}%`);
      const p = values.length;
      return `(subject ILIKE $${p} OR from_text ILIKE $${p} OR to_text ILIKE $${p} OR text ILIKE $${p})`;
    }

    // Header search
    case "HEADER": {
      const { field, text } = criterion.value as { field: string; text: string };
      const fieldLower = field.toLowerCase();
      let column: string | null = null;
      if (fieldLower === "subject") column = "subject";
      else if (fieldLower === "from") column = "from_text";
      else if (fieldLower === "to") column = "to_text";
      else if (fieldLower === "message-id") column = "message_id";
      // Unsupported header field — skip to avoid incorrect results
      // Only subject/from/to/message-id are stored as searchable columns.
      // An arbitrary header field can't be evaluated → fail closed (match-none)
      // rather than dropping the criterion and matching every message (#672).
      if (column === null) return MATCH_NONE;
      values.push(`%${text}%`);
      return `${column} ILIKE $${values.length}`;
    }

    // Custom keyword flags. The server stores only the system flag set and no
    // custom keywords, so KEYWORD <x> can never match (match-none) and
    // UNKEYWORD <x> always matches (match-all). Both are exact evaluations, not
    // fail-closed guesses (#672).
    case "KEYWORD":
      return MATCH_NONE;
    case "UNKEYWORD":
      return null;

    // Date criteria (using internal date — date column)
    case "BEFORE":
      values.push(criterion.value as Date);
      return `date < $${values.length}`;
    case "ON": {
      const onDate = criterion.value as Date;
      const nextDay = new Date(onDate);
      nextDay.setDate(nextDay.getDate() + 1);
      values.push(onDate, nextDay);
      return `date >= $${values.length - 1} AND date < $${values.length}`;
    }
    case "SINCE":
      values.push(criterion.value as Date);
      return `date >= $${values.length}`;
    // SENT* criteria use the same date column (we have only one date field)
    case "SENTBEFORE":
      values.push(criterion.value as Date);
      return `date < $${values.length}`;
    case "SENTON": {
      const sentOnDate = criterion.value as Date;
      const nextDay = new Date(sentOnDate);
      nextDay.setDate(nextDay.getDate() + 1);
      values.push(sentOnDate, nextDay);
      return `date >= $${values.length - 1} AND date < $${values.length}`;
    }
    case "SENTSINCE":
      values.push(criterion.value as Date);
      return `date >= $${values.length}`;

    // Size criteria: RFC822.SIZE is not persisted per-row, so the octet count
    // can't be evaluated. Fail closed (match-none) rather than dropping the
    // criterion — a dropped LARGER/SMALLER matches every message (fail-open),
    // the dangerous direction. Exact evaluation needs an rfc822_size column
    // (follow-up #665); until then match-none is the safe interim (#672).
    case "LARGER":
    case "SMALLER":
      return MATCH_NONE;

    // A UID sequence-set: its ranges are alternatives, so OR them among
    // themselves (a message matches if it falls in ANY range) while the whole
    // set still ANDs against sibling keys. An empty set imposes no constraint
    // (caller skips it). See #659.
    case "UID_SET": {
      const ranges = criterion.value as { start: number; end?: number }[];
      const parts = ranges.map((range) => {
        if (range.end === undefined) {
          values.push(range.start);
          return `${uidField} = $${values.length}`;
        }
        values.push(range.start, range.end);
        return `(${uidField} >= $${values.length - 1} AND ${uidField} <= $${values.length})`;
      });
      if (parts.length === 0) return null;
      return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
    }

    // Unsupported criterion — can't be evaluated, so fail closed (match-none)
    // rather than imposing no constraint and matching every message (#672).
    default:
      return MATCH_NONE;
  }
};

export const searchMailsByUid = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  criteria: { type: string; value?: unknown }[]
): Promise<number[]> => {
  try {
    // Column reference for the criterion clauses. Domain-scoped view
    // uses the plain column on `mails`; per-mailbox uses the
    // JOIN-aliased mapping. `buildCriterionClause` emits fragments like
    // `${uidField} >= $N`, so the alias needs to be qualified.
    const uidField = mailbox === null ? UID_DOMAIN : `x.${UID}`;

    // Always exclude expunged messages from search
    const conditions: string[] = ["m.user_id = $1", "m.sent = $2", "m.expunged = FALSE"];
    const values: ParamValue[] = [user_id, sent];

    // Base table + optional mailbox join
    let fromClause: string;
    if (mailbox === null) {
      fromClause = "mails m";
    } else {
      // JOIN mapping — the mailbox condition IS the membership predicate.
      conditions.push(`x.${USER_ID} = m.${USER_ID}`);
      conditions.push(`x.${MAILBOX} = $3`);
      conditions.push(`x.${MAIL_ID} = m.${MAIL_ID}`);
      values.push(mailbox);
      fromClause = `mails m, ${MAIL_MAILBOX_UID} x`;
    }

    for (const criterion of criteria) {
      // Criterion clauses reference columns on `mails` unqualified
      // (`answered = TRUE`, `to_address @> …`) — those still work under
      // the `m` alias since column names are unambiguous with the join.
      const frag = buildCriterionClause(criterion, uidField, values);
      if (frag) conditions.push(frag);
    }

    // No LIMIT: per RFC 3501 §6.4.4 SEARCH must return every matching
    // message. A cap with ORDER BY uid ASC would silently drop the
    // newest messages on mailboxes larger than the cap. Consistent with
    // the unbounded getAllUids / getMailsByRange enumeration paths.
    const sql = `
      SELECT ${uidField} as uid FROM ${fromClause}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${uidField} ASC
    `;

    const result = await pool.query(sql, values);
    return result.rows
      .map((row: Record<string, unknown>) => row.uid as number)
      .filter((uid: number) => uid > 0);
  } catch (error) {
    logger.error("Failed to search mails by UID", {}, error);
    return [];
  }
};

/**
 * Get all UIDs in a mailbox, ordered by UID ascending.
 * Used to build sequence number → UID mapping for IMAP sessions.
 */
export const getAllUids = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    let sql: string;
    let values: ParamValue[];

    if (mailbox === null) {
      sql = `
        SELECT ${UID_DOMAIN} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
        ORDER BY ${UID_DOMAIN} ASC
      `;
      values = [user_id, sent];
    } else {
      sql = `
        SELECT x.${UID} as uid FROM mails m
        JOIN ${MAIL_MAILBOX_UID} x
          ON x.${USER_ID} = m.${USER_ID}
          AND x.${MAILBOX} = $3
          AND x.${MAIL_ID} = m.${MAIL_ID}
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE
        ORDER BY x.${UID} ASC
      `;
      values = [user_id, sent, mailbox];
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    logger.error("Failed to get all UIDs", {}, error);
    return [];
  }
};

/**
 * UID of the lowest-UID unread (unseen) message in a mailbox, or null when
 * every message is read. Used to emit the RFC 3501 `[UNSEEN <seq>]` SELECT
 * response code, where the value is the sequence number of the first unseen
 * message — never the unread count.
 */
export const getFirstUnseenUid = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Promise<number | null> => {
  try {
    let sql: string;
    let values: ParamValue[];

    if (mailbox === null) {
      sql = `
        SELECT ${UID_DOMAIN} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE AND read = FALSE
        ORDER BY ${UID_DOMAIN} ASC
        LIMIT 1
      `;
      values = [user_id, sent];
    } else {
      sql = `
        SELECT x.${UID} as uid FROM mails m
        JOIN ${MAIL_MAILBOX_UID} x
          ON x.${USER_ID} = m.${USER_ID}
          AND x.${MAILBOX} = $3
          AND x.${MAIL_ID} = m.${MAIL_ID}
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE AND m.read = FALSE
        ORDER BY x.${UID} ASC
        LIMIT 1
      `;
      values = [user_id, sent, mailbox];
    }

    const result = await pool.query(sql, values);
    const uid = result.rows[0]?.uid;
    return uid === undefined ? null : (uid as number);
  } catch (error) {
    logger.error("Failed to get first unseen UID", {}, error);
    return null;
  }
};

/**
 * Soft-delete messages marked with \Deleted flag (EXPUNGE operation)
 * Sets expunged = TRUE instead of hard deleting.
 * Returns the UIDs of expunged messages for EXPUNGE responses.
 */
export const expungeDeletedMails = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    if (mailbox === null) {
      // Domain-wide expunge — still on uid_domain, unchanged.
      const rows = await mailsTable.updateWhere(
        { [USER_ID]: user_id, [SENT]: sent, [DELETED]: true, [EXPUNGED]: false },
        // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
        // resyncing CONDSTORE/QRESYNC client detects the removal.
        { [EXPUNGED]: true, updated: DB_NOW, [MODSEQ]: await getNextModseq(user_id) },
        [`${UID_DOMAIN} as uid`]
      );
      return rows.map((row: Record<string, unknown>) => row.uid as number);
    }

    // Per-mailbox expunge: JOIN `mail_mailbox_uid` to resolve the
    // mail_ids that belong to this mailbox, then framework updateWhere
    // with an IN filter so the data-bag pattern bumps `updated`. The
    // RETURNING side reads x.uid from a second SELECT that fetches the
    // per-mailbox UIDs for the just-expunged rows.
    const selectSql = `
      SELECT m.${MAIL_ID} as mail_id, x.${UID} as uid FROM mails m
      JOIN ${MAIL_MAILBOX_UID} x
        ON x.${USER_ID} = m.${USER_ID}
        AND x.${MAILBOX} = $3
        AND x.${MAIL_ID} = m.${MAIL_ID}
      WHERE m.${USER_ID} = $1 AND m.${SENT} = $2
        AND m.${DELETED} = TRUE AND m.${EXPUNGED} = FALSE
    `;
    const selectResult = await pool.query(selectSql, [user_id, sent, mailbox]);
    if (selectResult.rows.length === 0) return [];
    const mailIds = selectResult.rows.map(
      (row: Record<string, unknown>) => row.mail_id as string
    );
    const uidsByMailId = new Map<string, number>(
      selectResult.rows.map((row: Record<string, unknown>) => [
        row.mail_id as string,
        row.uid as number,
      ])
    );

    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: { op: "IN", value: mailIds } },
      // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
      // resyncing CONDSTORE/QRESYNC client detects the removal.
      { [EXPUNGED]: true, updated: DB_NOW, [MODSEQ]: await getNextModseq(user_id) },
      [MAIL_ID]
    );
    // Map the UPDATE's returned mail_ids back to their per-account UIDs
    // via the SELECT snapshot. This is the wire signal for EXPUNGE
    // responses.
    return rows
      .map((row: Record<string, unknown>) => uidsByMailId.get(row[MAIL_ID] as string))
      .filter((u): u is number => u !== undefined);
  } catch (error) {
    logger.error("Failed to expunge deleted mails", {}, error);
    return [];
  }
};

/**
 * Soft-delete a specific set of UIDs in one mailbox (per-mailbox /
 * sent-unified / domain), regardless of their `\Deleted` flag. The MOVE
 * command needs this — RFC 6851 §3.3 forbids the COPY+STORE(\Deleted)+EXPUNGE
 * pattern the prior implementation used (it caused mailbox-wide collateral
 * EXPUNGE of pre-existing \Deleted-flagged mails). Returns the UIDs
 * actually flipped, in case any were already expunged concurrently.
 */
export const expungeMailsByUid = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  uids: number[]
): Promise<number[]> => {
  if (uids.length === 0) return [];
  try {
    if (mailbox === null) {
      // Domain-wide: simple equality on user_id+sent + IN(uids).
      const rows = await mailsTable.updateWhere(
        {
          [USER_ID]: user_id,
          [SENT]: sent,
          [EXPUNGED]: false,
          [UID_DOMAIN]: { op: "IN", value: uids },
        },
        // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
        // resyncing CONDSTORE/QRESYNC client detects the removal.
        { [EXPUNGED]: true, updated: DB_NOW, [MODSEQ]: await getNextModseq(user_id) },
        [`${UID_DOMAIN} as uid`]
      );
      return rows.map((row: Record<string, unknown>) => row.uid as number);
    }

    // Per-mailbox: JOIN `mail_mailbox_uid` to filter by (mailbox, uid IN),
    // resolve the mail_ids, then updateWhere by mail_id IN so the data-bag
    // pattern bumps `updated`. Snapshot uid_by_mail_id so RETURNING can
    // map the UPDATE's mail_id output back to the per-mailbox UIDs.
    const uidPlaceholders = uids.map((_, i) => `$${i + 4}`).join(",");
    const selectSql = `
      SELECT m.${MAIL_ID} as mail_id, x.${UID} as uid FROM mails m
      JOIN ${MAIL_MAILBOX_UID} x
        ON x.${USER_ID} = m.${USER_ID}
        AND x.${MAILBOX} = $3
        AND x.${MAIL_ID} = m.${MAIL_ID}
      WHERE m.${USER_ID} = $1
        AND m.${SENT} = $2
        AND x.${UID} IN (${uidPlaceholders})
        AND m.${EXPUNGED} = FALSE
    `;
    const selectValues: ParamValue[] = [user_id, sent, mailbox, ...uids];
    const selectResult = await pool.query(selectSql, selectValues);
    const uidsByMailId = new Map<string, number>(
      selectResult.rows.map((row: Record<string, unknown>) => [
        row.mail_id as string,
        row.uid as number,
      ])
    );
    const mailIds = selectResult.rows.map(
      (row: Record<string, unknown>) => row.mail_id as string
    );
    if (mailIds.length === 0) return [];

    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: { op: "IN", value: mailIds } },
      // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
      // resyncing CONDSTORE/QRESYNC client detects the removal.
      { [EXPUNGED]: true, updated: DB_NOW, [MODSEQ]: await getNextModseq(user_id) },
      [MAIL_ID]
    );
    return rows
      .map((row: Record<string, unknown>) => uidsByMailId.get(row[MAIL_ID] as string))
      .filter((u): u is number => u !== undefined);
  } catch (error) {
    logger.error("Failed to expunge mails by UID", { uids }, error);
    throw error;
  }
};
