import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import {
  PartialMailModel,
  mailsTable,
  MAIL_ID,
  USER_ID,
  UID_DOMAIN,
  UID_ACCOUNT,
  MODSEQ,
  TO_ADDRESS,
  FROM_ADDRESS,
  SENT,
  DELETED,
  EXPUNGED,
} from "../../models";
import { getNextModseq } from "./counters";

export const countMessages = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<{ total: number; unread: number; maxUid: number }> => {
  try {
    let sql: string;
    let values: ParamValue[];
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    if (account === null) {
      // Domain-wide count (exclude expunged messages)
      sql = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
          COALESCE(MAX(${uidField}), 0) as max_uid
        FROM mails 
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
      `;
      values = [user_id, sent];
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
          COALESCE(MAX(${uidField}), 0) as max_uid
        FROM mails
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE
      `;
      values = [user_id, sent, addressJson];
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

export const getMailsByRange = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[] = ["*"]
): Promise<Map<string, PartialMailModel>> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

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
    const fieldList = safeFields.length > 0 ? safeFields.join(", ") : "*";

    if (account === null) {
      // Domain-wide query (exclude expunged messages)
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${uidField} >= $3 AND ${uidField} <= $4
            AND expunged = FALSE
          ORDER BY ${uidField} ASC
        `;
        values = [user_id, sent, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
          ORDER BY ${uidField} ASC
          OFFSET $3 LIMIT $4
        `;
        values = [user_id, sent, start - 1, end - start + 1];
      }
    } else {
      // Account-specific query (exclude expunged messages)
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            AND ${uidField} >= $4 AND ${uidField} <= $5 AND expunged = FALSE
          ORDER BY ${uidField} ASC
        `;
        values = [user_id, sent, addressJson, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE
          ORDER BY ${uidField} ASC
          OFFSET $4 LIMIT $5
        `;
        values = [user_id, sent, addressJson, start - 1, end - start + 1];
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
  account: string | null,
  sent: boolean,
  start: number,
  end: number,
  flags: string[],
  useUid: boolean,
  operation: StoreOperationType = "FLAGS"
): Promise<UpdatedMailFlags[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;
    const setClause = buildFlagSetClause(operation, flags);
    const returningCols = `${uidField} as uid, read, saved, deleted, draft, answered`;

    // Build the row-matching predicate + its bound params once, shared by the
    // real-change UPDATE and the no-op SELECT below. `$`-indices are 1-based and
    // never include the mod-sequence (appended by the UPDATE branch only).
    let whereClause: string;
    let whereValues: ParamValue[];
    if (account === null) {
      if (useUid) {
        whereClause = `user_id = $1 AND sent = $2 AND ${uidField} >= $3 AND ${uidField} <= $4`;
        whereValues = [user_id, sent, start, end];
      } else {
        whereClause = `mail_id IN (
          SELECT mail_id FROM mails
          WHERE user_id = $1 AND sent = $2
          ORDER BY ${uidField} ASC
          OFFSET $3 LIMIT 1
        )`;
        whereValues = [user_id, sent, start];
      }
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      if (useUid) {
        whereClause = `user_id = $1 AND sent = $2 AND ${addressCondition}
          AND ${uidField} >= $4 AND ${uidField} <= $5`;
        whereValues = [user_id, sent, addressJson, start, end];
      } else {
        whereClause = `mail_id IN (
          SELECT mail_id FROM mails
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
          ORDER BY ${uidField} ASC
          OFFSET $4 LIMIT 1
        )`;
        whereValues = [user_id, sent, addressJson, start];
      }
    }

    // No recognized flag change (empty `+FLAGS ()` / `-FLAGS ()` or unknown-only
    // keywords): RFC 3501 §6.4.6 makes this a legal no-op. Return the matched
    // rows' CURRENT flags without an UPDATE — a no-op must not bump `updated`
    // (delta-sync cursor) or reserve a new mod-sequence (RFC 7162: modseq only
    // advances when flags actually change).
    if (!setClause) {
      const result = await pool.query(
        `SELECT ${returningCols} FROM mails WHERE ${whereClause}`,
        whereValues
      );
      return result.rows.map(toUpdatedMailFlags);
    }

    // One fresh mod-sequence for this STORE, stamped on every matched row so a
    // CONDSTORE client sees one modseq for the whole flag change (RFC 7162 §3.1
    // — a batch mutation may share a single mod-sequence). Reserved atomically so
    // concurrent STOREs get strictly-distinct, monotonic values.
    const modseq = await getNextModseq(user_id);
    const result = await pool.query(
      `UPDATE mails
       SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $${whereValues.length + 1}
       WHERE ${whereClause}
       RETURNING ${returningCols}`,
      [...whereValues, modseq]
    );
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
});

/**
 * Builds the SQL boolean fragment for a single IMAP SEARCH criterion, pushing any
 * bound parameters onto `values` (1-indexed `$N` placeholders track `values.length`).
 * Returns `null` for criteria that impose no constraint (ALL, unsupported keys), so
 * the caller simply skips them. NOT/OR recurse so negation and disjunction compose
 * instead of falling through and matching every message.
 */
export const buildCriterionClause = (
  criterion: { type: string; value?: unknown },
  uidField: string,
  values: ParamValue[]
): string | null => {
  const type = criterion.type.toUpperCase();
  switch (type) {
    // Logical operators — recurse into operands carried on `value`.
    case "NOT": {
      const inner = buildCriterionClause(
        criterion.value as { type: string; value?: unknown },
        uidField,
        values
      );
      return inner ? `NOT (${inner})` : null;
    }
    case "OR": {
      const { left, right } = criterion.value as {
        left: { type: string; value?: unknown };
        right: { type: string; value?: unknown };
      };
      const l = buildCriterionClause(left, uidField, values);
      const r = buildCriterionClause(right, uidField, values);
      if (l && r) return `(${l} OR ${r})`;
      // One side imposes no constraint: an OR with an unconstrained side matches
      // everything, so drop the whole disjunction rather than over-narrow it.
      return null;
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
      if (column === null) return null;
      values.push(`%${text}%`);
      return `${column} ILIKE $${values.length}`;
    }

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

    // Size criteria: not tracked per-row; skip to avoid incorrect results
    case "LARGER":
    case "SMALLER":
      return null;

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

    // Unsupported criterion — impose no constraint (caller skips it).
    default:
      return null;
  }
};

export const searchMailsByUid = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  criteria: { type: string; value?: unknown }[]
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    // Always exclude expunged messages from search
    const conditions: string[] = ["user_id = $1", "sent = $2", "expunged = FALSE"];
    const values: ParamValue[] = [user_id, sent];
    let paramIdx = 3;

    if (account !== null) {
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $${paramIdx}::jsonb`
        : `(${TO_ADDRESS} @> $${paramIdx}::jsonb OR cc_address @> $${paramIdx}::jsonb OR bcc_address @> $${paramIdx}::jsonb OR envelope_to @> $${paramIdx}::jsonb)`;
      conditions.push(addressCondition);
      values.push(addressJson);
      paramIdx++;
    }

    for (const criterion of criteria) {
      const frag = buildCriterionClause(criterion, uidField, values);
      if (frag) conditions.push(frag);
    }

    // No LIMIT: per RFC 3501 §6.4.4 SEARCH must return every matching
    // message. A cap with ORDER BY uid ASC would silently drop the
    // newest messages on mailboxes larger than the cap. Consistent with
    // the unbounded getAllUids / getMailsByRange enumeration paths.
    const sql = `
      SELECT ${uidField} as uid FROM mails
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
  account: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      // Domain-wide query (exclude expunged messages)
      sql = `
        SELECT ${uidField} as uid FROM mails 
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
        ORDER BY ${uidField} ASC
      `;
      values = [user_id, sent];
    } else {
      // Account-specific query (exclude expunged messages)
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      sql = `
        SELECT ${uidField} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE
        ORDER BY ${uidField} ASC
      `;
      values = [user_id, sent, addressJson];
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
  account: string | null,
  sent: boolean
): Promise<number | null> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      // Domain-wide query (exclude expunged messages)
      sql = `
        SELECT ${uidField} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE AND read = FALSE
        ORDER BY ${uidField} ASC
        LIMIT 1
      `;
      values = [user_id, sent];
    } else {
      // Account-specific query (exclude expunged messages)
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      sql = `
        SELECT ${uidField} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND expunged = FALSE AND read = FALSE
        ORDER BY ${uidField} ASC
        LIMIT 1
      `;
      values = [user_id, sent, addressJson];
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
  account: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    if (account === null) {
      // Domain-wide expunge: simple equality filters → use the framework's
      // updateWhere so `updated` is bumped via the standard data-bag pattern.
      const rows = await mailsTable.updateWhere(
        { [USER_ID]: user_id, [SENT]: sent, [DELETED]: true, [EXPUNGED]: false },
        // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
        // resyncing CONDSTORE/QRESYNC client detects the removal.
        { [EXPUNGED]: true, updated: new Date(), [MODSEQ]: await getNextModseq(user_id) },
        [`${uidField} as uid`]
      );
      return rows.map((row: Record<string, unknown>) => row.uid as number);
    }

    // Account-specific expunge: the address filter uses jsonb `@>` containment
    // (with an OR across to/cc/bcc on the recv side), which WhereFilters cannot
    // express. Two-step: raw SELECT to resolve mail_ids, then framework
    // updateWhere with an IN filter so the data-bag pattern bumps `updated`.
    const addressJson = JSON.stringify([{ address: account }]);
    const addressCondition = sent
      ? `${FROM_ADDRESS} @> $3::jsonb`
      : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
    const selectSql = `
      SELECT ${MAIL_ID} as mail_id FROM mails
      WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND deleted = TRUE AND expunged = FALSE
    `;
    const selectValues: ParamValue[] = [user_id, sent, addressJson];
    const selectResult = await pool.query(selectSql, selectValues);
    const mailIds = selectResult.rows.map((row: Record<string, unknown>) => row.mail_id as string);
    if (mailIds.length === 0) return [];

    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: { op: "IN", value: mailIds } },
      // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
      // resyncing CONDSTORE/QRESYNC client detects the removal.
      { [EXPUNGED]: true, updated: new Date(), [MODSEQ]: await getNextModseq(user_id) },
      [`${uidField} as uid`]
    );
    return rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    logger.error("Failed to expunge deleted mails", {}, error);
    return [];
  }
};

/**
 * Soft-delete a specific set of UIDs in one mailbox (account / sent /
 * domain), regardless of their `\Deleted` flag. The MOVE command needs
 * this — RFC 6851 §3.3 forbids the COPY+STORE(\Deleted)+EXPUNGE pattern
 * the prior implementation used (it caused mailbox-wide collateral
 * EXPUNGE of pre-existing \Deleted-flagged mails). Returns the UIDs
 * actually flipped, in case any were already expunged concurrently.
 */
export const expungeMailsByUid = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  uids: number[]
): Promise<number[]> => {
  if (uids.length === 0) return [];
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    if (account === null) {
      // Domain-wide: simple equality on user_id+sent + IN(uids).
      const rows = await mailsTable.updateWhere(
        {
          [USER_ID]: user_id,
          [SENT]: sent,
          [EXPUNGED]: false,
          [uidField]: { op: "IN", value: uids },
        },
        // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
        // resyncing CONDSTORE/QRESYNC client detects the removal.
        { [EXPUNGED]: true, updated: new Date(), [MODSEQ]: await getNextModseq(user_id) },
        [`${uidField} as uid`]
      );
      return rows.map((row: Record<string, unknown>) => row.uid as number);
    }

    // Account-specific: mirror `expungeDeletedMails`'s two-step pattern.
    // SELECT mail_ids via the address-OR predicate + UID IN, then UPDATE
    // by mail_id IN so the data-bag pattern bumps `updated`.
    const addressJson = JSON.stringify([{ address: account }]);
    const addressCondition = sent
      ? `${FROM_ADDRESS} @> $3::jsonb`
      : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
    const uidPlaceholders = uids.map((_, i) => `$${i + 4}`).join(",");
    const selectSql = `
      SELECT ${MAIL_ID} as mail_id FROM mails
      WHERE user_id = $1
        AND sent = $2
        AND ${addressCondition}
        AND ${uidField} IN (${uidPlaceholders})
        AND expunged = FALSE
    `;
    const selectValues: ParamValue[] = [user_id, sent, addressJson, ...uids];
    const selectResult = await pool.query(selectSql, selectValues);
    const mailIds = selectResult.rows.map(
      (row: Record<string, unknown>) => row.mail_id as string
    );
    if (mailIds.length === 0) return [];

    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: { op: "IN", value: mailIds } },
      // Bump modseq so the expunge advances HIGHESTMODSEQ (RFC 7162) — a
      // resyncing CONDSTORE/QRESYNC client detects the removal.
      { [EXPUNGED]: true, updated: new Date(), [MODSEQ]: await getNextModseq(user_id) },
      [`${uidField} as uid`]
    );
    return rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    logger.error("Failed to expunge mails by UID", { uids }, error);
    throw error;
  }
};
