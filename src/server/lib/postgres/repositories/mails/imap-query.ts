/**
 * The range and count SQL the IMAP mail reads issue, built with no pool
 * involved so the emitted string, its projection and its bound parameters can
 * be asserted directly.
 *
 * ```ts
 * const { sql, values, selectedFields } = buildMailsByRangeQuery(...);
 * const result = await pool.query(sql, values);
 * ```
 */
import { logger } from "../../../logger";
import { ParamValue } from "../../database";
import {
  PartialMailModel,
  MAIL_ID,
  USER_ID,
  UID_DOMAIN,
  MODSEQ,
  SENT,
  DELETED,
  EXPUNGED,
  MAIL_MAILBOX_UID,
  MAILBOX,
  UID,
} from "../../models";
import {
  membershipCondition,
  membershipExpression,
  membershipFilter,
  usesDomainUidSpace,
} from "./views";

export const buildCountMessagesQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  let sql: string;
  let values: ParamValue[];

  // `total` / `unread` describe what the mailbox contains, so they honour the
  // membership rule. UIDNEXT is NOT computed here — it comes from
  // `getUidNext`, which reads `mail_uid_counters`, the authority that assigns
  // UIDs. A `MAX(uid)` over these rows cannot back UIDNEXT: it drops when the
  // highest-UID mail is spam-quarantined, expunged or hard-deleted, and RFC
  // 3501 §2.3.1.1 requires UIDNEXT to exceed every UID ever assigned.
  const membership = membershipExpression(mailbox, sent);

  if (usesDomainUidSpace(mailbox)) {
    sql = `
        SELECT
          COUNT(*) FILTER (WHERE ${membership}) as total,
          COUNT(*) FILTER (WHERE read = FALSE AND ${membership}) as unread
        FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
      `;
    values = [user_id, sent];
  } else {
    // Per-mailbox view — the `mail_mailbox_uid` mapping is the
    // authoritative membership source. INNER JOIN encodes it: a row
    // exists iff the mail is in this mailbox. Legacy mails that predate
    // the write-side dual-write and never got backfilled have no mapping
    // row and are intentionally invisible to reads.
    const joinMembership = membershipExpression(mailbox, sent, "m.");
    sql = `
        SELECT
          COUNT(*) FILTER (WHERE ${joinMembership}) as total,
          COUNT(*) FILTER (WHERE m.read = FALSE AND ${joinMembership}) as unread
        FROM mails m
        JOIN ${MAIL_MAILBOX_UID} x
          ON x.${USER_ID} = m.${USER_ID}
          AND x.${MAILBOX} = $3
          AND x.${MAIL_ID} = m.${MAIL_ID}
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE
      `;
    values = [user_id, sent, mailbox];
  }
  return { sql, values };
};

export const buildMailsByRangeQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[],
  changedSince?: number
): {
  sql: string;
  values: ParamValue[];
  /** The projection the rows come back under — the `PartialMailModel` key set. */
  selectedFields: string[];
} => {
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

  // RFC 4551 CHANGEDSINCE: filter to messages whose mod-sequence exceeds the
  // requested value in the same range query (O(rows-changed), not a JS
  // post-filter over the whole window). `modseq` is BIGINT NOT NULL DEFAULT 1
  // so every row has a value — `CHANGEDSINCE 0` returns all, `CHANGEDSINCE 1`
  // drops the never-modified baseline. The predicate references the param
  // appended after each branch's fixed argument list ($5 domain, $6 per-box).
  const modseqDomainClause =
    changedSince !== undefined ? ` AND ${MODSEQ} > $5` : "";
  const modseqMailboxClause =
    changedSince !== undefined ? ` AND m.${MODSEQ} > $6` : "";

  if (usesDomainUidSpace(mailbox)) {
    // Domain-wide query (INBOX / unified Sent Messages) — still on
    // uid_domain, unchanged by the per-mailbox mapping migration.
    const projection = mailsColumns.length > 0 ? mailsColumns.join(", ") : "*";
    const uidMailboxAlias = wantsUidMailbox
      ? `, ${UID_DOMAIN} AS uid_mailbox`
      : "";
    const fieldList = `${projection}${uidMailboxAlias}${octetProjections("")}`;
    const membership = membershipCondition(mailbox, sent);
    if (useUid) {
      sql = `
          SELECT ${fieldList} FROM mails
          WHERE user_id = $1 AND sent = $2 AND ${UID_DOMAIN} >= $3 AND ${UID_DOMAIN} <= $4
            AND expunged = FALSE${membership}${modseqDomainClause}
          ORDER BY ${UID_DOMAIN} ASC
        `;
      values = [user_id, sent, start, Math.min(end, 999999999)];
      if (changedSince !== undefined) values.push(changedSince);
    } else {
      sql = `
          SELECT ${fieldList} FROM mails
          WHERE user_id = $1 AND sent = $2 AND expunged = FALSE${membership}${modseqDomainClause}
          ORDER BY ${UID_DOMAIN} ASC
          OFFSET $3 LIMIT $4
        `;
      values = [user_id, sent, start - 1, end - start + 1];
      if (changedSince !== undefined) values.push(changedSince);
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
    const membership = membershipCondition(mailbox, sent, "m.");
    if (useUid) {
      sql = `
          SELECT ${fieldList} FROM mails m
          JOIN ${MAIL_MAILBOX_UID} x
            ON x.${USER_ID} = m.${USER_ID}
            AND x.${MAILBOX} = $3
            AND x.${MAIL_ID} = m.${MAIL_ID}
          WHERE m.${USER_ID} = $1 AND m.${SENT} = $2
            AND x.${UID} >= $4 AND x.${UID} <= $5
            AND m.${EXPUNGED} = FALSE${membership}${modseqMailboxClause}
          ORDER BY x.${UID} ASC
        `;
      values = [user_id, sent, mailbox, start, Math.min(end, 999999999)];
      if (changedSince !== undefined) values.push(changedSince);
    } else {
      sql = `
          SELECT ${fieldList} FROM mails m
          JOIN ${MAIL_MAILBOX_UID} x
            ON x.${USER_ID} = m.${USER_ID}
            AND x.${MAILBOX} = $3
            AND x.${MAIL_ID} = m.${MAIL_ID}
          WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE${membership}${modseqMailboxClause}
          ORDER BY x.${UID} ASC
          OFFSET $4 LIMIT $5
        `;
      values = [user_id, sent, mailbox, start - 1, end - start + 1];
      if (changedSince !== undefined) values.push(changedSince);
    }
  }
  return { sql, values, selectedFields: safeFields };
};

/**
 * SQL fragment for a criterion the backend cannot express as a real predicate,
 * but which the RFC 3501 §6.4.4 semantics say matches NO message (e.g. KEYWORD
 * when no custom keywords are stored). Emitting a literal `FALSE` fails the
 * search CLOSED — the safe direction — instead of dropping the criterion, which
 * would leave it out of the WHERE clause and match every message (fail-open).
 */
export const MATCH_NONE = "FALSE";

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
      if (column === null) return MATCH_NONE;
      values.push(`%${text}%`);
      return `${column} ILIKE $${values.length}`;
    }

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

    case "LARGER":
    case "SMALLER":
      return MATCH_NONE;

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

    default:
      return MATCH_NONE;
  }
};

export const buildSearchMailsByUidQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  criteria: { type: string; value?: unknown }[]
): { sql: string; values: ParamValue[] } => {
  // Column reference for the criterion clauses. Domain-scoped view
  // uses the plain column on `mails`; per-mailbox uses the
  // JOIN-aliased mapping. `buildCriterionClause` emits fragments like
  // `${uidField} >= $N`, so the alias needs to be qualified.
  const uidField = usesDomainUidSpace(mailbox) ? UID_DOMAIN : `x.${UID}`;

  // Always exclude expunged messages from search, and anything the mailbox
  // doesn't show — SEARCH must not return UIDs the client can't FETCH.
  const conditions: string[] = [
    "m.user_id = $1",
    "m.sent = $2",
    "m.expunged = FALSE",
    membershipExpression(mailbox, sent, "m."),
  ];
  const values: ParamValue[] = [user_id, sent];

  // Base table + optional mailbox join
  let fromClause: string;
  if (usesDomainUidSpace(mailbox)) {
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
  return { sql, values };
};

export const buildAllUidsQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  let sql: string;
  let values: ParamValue[];

  if (usesDomainUidSpace(mailbox)) {
    sql = `
        SELECT ${UID_DOMAIN} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE${membershipCondition(mailbox, sent)}
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
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE${membershipCondition(mailbox, sent, "m.")}
        ORDER BY x.${UID} ASC
      `;
    values = [user_id, sent, mailbox];
  }
  return { sql, values };
};

export const buildFirstUnseenUidQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  let sql: string;
  let values: ParamValue[];

  if (usesDomainUidSpace(mailbox)) {
    sql = `
        SELECT ${UID_DOMAIN} as uid FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE AND read = FALSE${membershipCondition(mailbox, sent)}
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
        WHERE m.${USER_ID} = $1 AND m.${SENT} = $2 AND m.${EXPUNGED} = FALSE AND m.read = FALSE${membershipCondition(mailbox, sent, "m.")}
        ORDER BY x.${UID} ASC
        LIMIT 1
      `;
    values = [user_id, sent, mailbox];
  }
  return { sql, values };
};

/**
 * Rows an EXPUNGE addresses on a domain-scoped view. EXPUNGE removes
 * `\Deleted` messages *from the selected mailbox*, so a mail the box does not
 * show is out of reach here too — otherwise an INBOX EXPUNGE would collect
 * spam the client never saw and could not have flagged.
 */
export const buildExpungeDeletedFilters = (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Record<string, unknown> => ({
  [USER_ID]: user_id,
  [SENT]: sent,
  [DELETED]: true,
  [EXPUNGED]: false,
  ...membershipFilter(mailbox, sent),
});

/** The mapped-box twin: resolves the mail_ids and their per-mailbox UIDs. */
export const buildExpungeDeletedSelectQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): { sql: string; values: ParamValue[] } => {
  const selectSql = `
      SELECT m.${MAIL_ID} as mail_id, x.${UID} as uid FROM mails m
      JOIN ${MAIL_MAILBOX_UID} x
        ON x.${USER_ID} = m.${USER_ID}
        AND x.${MAILBOX} = $3
        AND x.${MAIL_ID} = m.${MAIL_ID}
      WHERE m.${USER_ID} = $1 AND m.${SENT} = $2
        AND m.${DELETED} = TRUE AND m.${EXPUNGED} = FALSE${membershipCondition(mailbox, sent, "m.")}
    `;
  return { sql: selectSql, values: [user_id, sent, mailbox] };
};

/**
 * Rows a MOVE's source-side removal addresses on a domain-scoped view. Same
 * membership rule as EXPUNGE, regardless of the `\Deleted` flag — RFC 6851
 * §3.3 forbids the COPY+STORE+EXPUNGE pattern this replaces.
 */
export const buildExpungeUidsFilters = (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  uids: number[]
): Record<string, unknown> => ({
  [USER_ID]: user_id,
  [SENT]: sent,
  [EXPUNGED]: false,
  [UID_DOMAIN]: { op: "IN", value: uids },
  ...membershipFilter(mailbox, sent),
});

/** The mapped-box twin: resolves the mail_ids and their per-mailbox UIDs. */
export const buildExpungeUidsSelectQuery = (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  uids: number[]
): { sql: string; values: ParamValue[] } => {
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
        AND m.${EXPUNGED} = FALSE${membershipCondition(mailbox, sent, "m.")}
    `;
  const selectValues: ParamValue[] = [user_id, sent, mailbox, ...uids];
  return { sql: selectSql, values: selectValues };
};
