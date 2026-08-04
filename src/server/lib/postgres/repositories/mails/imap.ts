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
import {
  filtersMembership,
  membershipCondition,
  membershipExpression,
  membershipFilter,
  usesDomainUidSpace,
} from "./views";

/**
 * Character-length chunk size for the SUBSTRING body-streaming reader. Chosen
 * so the encoded UTF-8 chunk stays under SLICE_RAW_BYTES (48 KiB) in the
 * emitBase64 pipeline: worst-case UTF-8 expansion is 4 bytes per character,
 * so 12 000 chars → up to 48 000 bytes → fits safely under 49 152. Pg's
 * SUBSTRING is CHARACTER-indexed, not byte-indexed, so the constant is in
 * characters (code points), not bytes.
 */
export const PG_TEXT_CHUNK_CHARS = 12_000;

/**
 * Stream one mail row's `text` or `html` column in fixed-size character
 * chunks. Each round-trip pulls at most PG_TEXT_CHUNK_CHARS characters via a
 * `SUBSTRING(<col> FROM $off FOR $chunk)` query — the whole column never
 * loads into Node's heap. Complements `getMailsByRange`'s `text_octets` /
 * `html_octets` synthetic projections: the caller pre-measures the `{N}`
 * literal from the octet count, then streams the body via this generator.
 *
 * Stops when a SUBSTRING call returns an empty string (Postgres serves an
 * empty string for offsets past the column length, which is the natural
 * terminator).
 *
 * The `sourceColumn` is a hard-coded literal, not user input — narrowed to
 * "text" | "html" at the type level so it can be interpolated into the SQL
 * safely.
 */
export async function* pgTextChunks(
  mail_id: string,
  user_id: string,
  sourceColumn: "text" | "html",
  chunkChars: number = PG_TEXT_CHUNK_CHARS
): AsyncGenerator<string, void, unknown> {
  // Postgres SUBSTRING(text FROM start FOR len): `start` is 1-indexed. We
  // step by `chunkChars` chars each round-trip; a chunk shorter than
  // `chunkChars` OR empty means we've drained the column.
  //
  // The `$3::int FOR $4::int` casts are LOAD-BEARING. `pg` sends JS
  // number params as text with no OID hint, so Postgres has to infer
  // types from the SUBSTRING call site. Three overloads share the
  // shape:
  //   substring(text, int, int)       — numeric offsets (what we want)
  //   substring(text, text, text)     — SIMILAR TO pattern + escape char
  //   substring(text, text)           — regex pattern
  // Postgres picks (2) for two-text params, then reads $4 (`"12000"`)
  // as the ESCAPE CHARACTER — which must be exactly one character —
  // and throws `invalid escape string`. Every lazy-body BODY[] stream
  // fails on the first chunk with no client-side surface (the response
  // never assembles). Explicit `::int` casts pin the intended overload.
  yield* pageByCodePoints(async (offset, take) => {
    const sql = `SELECT SUBSTRING(${sourceColumn} FROM $3::int FOR $4::int) AS chunk
                 FROM mails WHERE mail_id = $1 AND user_id = $2`;
    const result = await pool.query(sql, [mail_id, user_id, offset, take]);
    return (result.rows[0]?.chunk ?? "") as string;
  }, chunkChars);
}

export async function* pageByCodePoints(
  readChunk: (offset: number, take: number) => Promise<string>,
  chunkChars: number
): AsyncGenerator<string, void, unknown> {
  let offset = 1;
  for (;;) {
    const chunk = await readChunk(offset, chunkChars);
    if (chunk.length === 0) return;
    yield chunk;
    const codePoints = countCodePoints(chunk);
    if (codePoints < chunkChars) return;
    offset += codePoints;
  }
}

/**
 * Byte-length chunk size for the byte-indexed reader below. Divisible by 3 so
 * every emitted chunk base64-encodes without carrying a residual across the
 * chunk boundary (`4 * ceil(n/3)` == `4 * n/3` exactly when `n % 3 == 0`).
 * 48 KiB matches SLICE_RAW_BYTES in session-utils.ts's emitBase64 pipeline —
 * one PG round-trip per socket-write-sized chunk.
 */
export const PG_TEXT_CHUNK_BYTES = 48 * 1024;

if (PG_TEXT_CHUNK_BYTES % 3 !== 0) {
  throw new Error(
    `PG_TEXT_CHUNK_BYTES must be divisible by 3 so per-chunk base64 encoding needs no cross-chunk carry, got ${PG_TEXT_CHUNK_BYTES}`
  );
}

/**
 * Stream one mail row's `text` or `html` column as raw UTF-8 BYTES in
 * fixed-size chunks. Reads via
 * `SUBSTRING(convert_to(col, 'UTF8') FROM $off FOR $len)`.
 * `convert_to(text, 'UTF8')` is a charset-conversion function that
 * returns a bytea holding the column's UTF-8 encoding — a no-op
 * transcode on the (server-encoding = UTF8) production DB, but not a
 * cast: the `::bytea` operator would send the text through `byteain`'s
 * escape parser and throw `invalid input syntax for type bytea` on any
 * mail whose body contains a `\<letter>` byte sequence (3.5% of the
 * corpus locally). `SUBSTRING` on `bytea` is BYTE-indexed (1-indexed),
 * which is exactly what the base64-encoding consumer wants: no
 * code-point ↔ byte translation, and a partial-fetch caller can seek
 * directly to a 3-byte-aligned position instead of draining from
 * codepoint 1.
 *
 * `startByte` is the 1-indexed byte position to begin at (default 1 for
 * the whole column). `chunkBytes` defaults to `PG_TEXT_CHUNK_BYTES`
 * (48 KiB, a multiple of 3).
 *
 * Complements [[pgTextChunks]]: use `pgTextChunks` when the consumer
 * needs decoded UTF-16 strings (search, tokenization, header parsing);
 * use `pgByteChunks` when the consumer will re-encode as bytes (base64
 * for wire IMAP FETCH). Splitting a multi-byte UTF-8 sequence at a
 * chunk boundary is fine here — the consumer never decodes; the bytes
 * concatenate correctly and the client's base64 decoder receives
 * byte-exact input.
 *
 * The `sourceColumn` is a hard-coded literal ("text" | "html"),
 * narrowed at the type level so it can be interpolated into the SQL
 * safely.
 */
export async function* pgByteChunks(
  mail_id: string,
  user_id: string,
  sourceColumn: "text" | "html",
  startByte: number = 1,
  chunkBytes: number = PG_TEXT_CHUNK_BYTES
): AsyncGenerator<Buffer, void, unknown> {
  // The `$3::int FOR $4::int` casts are defensive here — `substring(bytea,
  // int, int)` is the sole overload on bytea (no SIMILAR-TO-pattern
  // ambiguity to resolve, unlike pgTextChunks's `text` overload set) —
  // but keeping the casts matches pgTextChunks' shape and eliminates any
  // future risk of pg driver text-encoded params confusing type inference.
  let offset = startByte;
  for (;;) {
    const sql = `SELECT SUBSTRING(convert_to(${sourceColumn}, 'UTF8') FROM $3::int FOR $4::int) AS chunk
                 FROM mails WHERE mail_id = $1 AND user_id = $2`;
    const result = await pool.query(sql, [mail_id, user_id, offset, chunkBytes]);
    const chunk = (result.rows[0]?.chunk ?? Buffer.alloc(0)) as Buffer;
    if (chunk.byteLength === 0) return;
    yield chunk;
    if (chunk.byteLength < chunkBytes) return;
    offset += chunk.byteLength;
  }
}

/**
 * Code points in a UTF-16 string — `[...s].length` without allocating an
 * array per chunk. Postgres hands back well-formed UTF-8, so every high
 * surrogate here is followed by its low half; the pair check is still
 * explicit so a lone surrogate counts as one rather than swallowing the
 * next character.
 */
const countCodePoints = (s: string): number => {
  let count = 0;
  for (let i = 0; i < s.length; i++, count++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  return count;
};

/**
 * Callers pass `mailbox` as the raw IMAP box path (e.g. `INBOX/accounts/amazon`,
 * `Sent Messages/accounts/claoie`, a user-created box like `Archive`, or a
 * utility view like `Drafts`). For a mapped box that is the exact string the
 * write side stores in `mail_mailbox_uid.mailbox`; for a utility view it is the
 * key its membership rule is looked up under. `null` is reserved for the two
 * views with no name of their own, `INBOX` and the unified `Sent Messages`.
 *
 * Which branch a box takes is `usesDomainUidSpace`, not `mailbox === null` —
 * see `views.ts`.
 */

export const countMessages = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean
): Promise<{ total: number; unread: number; maxUid: number }> => {
  try {
    let sql: string;
    let values: ParamValue[];

    const membership = membershipExpression(mailbox, sent);

    if (usesDomainUidSpace(mailbox)) {
      sql = `
        SELECT
          COUNT(*) FILTER (WHERE ${membership}) as total,
          COUNT(*) FILTER (WHERE read = FALSE AND ${membership}) as unread,
          COALESCE(MAX(${UID_DOMAIN}), 0) as max_uid
        FROM mails
        WHERE user_id = $1 AND sent = $2 AND expunged = FALSE
      `;
      values = [user_id, sent];
    } else {
      const joinMembership = membershipExpression(mailbox, sent, "m.");
      sql = `
        SELECT
          COUNT(*) FILTER (WHERE ${joinMembership}) as total,
          COUNT(*) FILTER (WHERE m.read = FALSE AND ${joinMembership}) as unread,
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
  fields: string[] = ["*"],
  changedSince?: number
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
    changedSince ?? null,
  ]);
  return singleFlight(inflightKey, () => getMailsByRangeUncoalesced(
    user_id, mailbox, sent, start, end, useUid, fields, changedSince
  ));
};

const getMailsByRangeUncoalesced = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[],
  changedSince?: number
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
  // The mail_id the row identifies. Needed by the caller to sync pivot rows
  // in `mail_mailbox_uid` for mapped-utility folders (`Starred`, `Trash`) —
  // a STORE that flips `saved` / `deleted` has to insert or delete the
  // corresponding pivot so the utility view stays truthful. See
  // `syncMailboxPivot` in `counters.ts` and the STORE hook in
  // `imap/message-ops.ts`.
  mail_id: string;
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

export interface SetMailFlagsResult {
  updated: UpdatedMailFlags[];
  /**
   * UIDs the range matched whose mod-sequence exceeded the caller's
   * UNCHANGEDSINCE — their flags are untouched and they belong in the tagged
   * MODIFIED response code (RFC 7162 §3.1.3). Always empty for an
   * unconditional STORE.
   */
  failed: number[];
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
  operation: StoreOperationType = "FLAGS",
  unchangedSince?: number
): Promise<SetMailFlagsResult> => {
  try {
    const setClause = buildFlagSetClause(operation, flags);
    // RFC 7162 §3.1.3: with UNCHANGEDSINCE the UPDATE additionally requires the
    // row's current mod-sequence to be ≤ the client's value. Rows that fail it
    // keep their flags and come back in MODIFIED. `modseq` is stamped at 1 on
    // every row when the column is added, so `<= 0` matches nothing — which is
    // exactly the RFC's "UNCHANGEDSINCE 0 always fails" rule, for free.
    const conditional = unchangedSince !== undefined;

    // Two flavors of query — domain-scoped stays on `mails.uid_domain`,
    // per-mailbox joins `mail_mailbox_uid`. RETURNING clauses select
    // the appropriate UID and the shared flag/modseq columns.
    let selectSql: string;
    let updateSql: string;
    let baseValues: ParamValue[];

    // A STORE addresses messages *in the selected mailbox*, so it has to see
    // the same set the reads do — otherwise `UID STORE 1:* +FLAGS (\Deleted)`
    // on INBOX would flag quarantined spam the client was never shown, and the
    // following EXPUNGE would destroy it.
    const membership = membershipCondition(mailbox, sent);

    if (usesDomainUidSpace(mailbox)) {
      const returningCols = `${MAIL_ID}, ${UID_DOMAIN} as uid, read, saved, deleted, draft, answered, ${MODSEQ} as modseq`;
      if (useUid) {
        const whereClause = `user_id = $1 AND sent = $2 AND ${UID_DOMAIN} >= $3 AND ${UID_DOMAIN} <= $4${membership}`;
        selectSql = `SELECT ${returningCols} FROM mails WHERE ${whereClause}`;
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
        updateSql = `UPDATE mails
          SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $4
          WHERE ${whereClause}${conditional ? ` AND ${MODSEQ} <= $5` : ""}
          RETURNING ${returningCols}`;
        baseValues = [user_id, sent, start];
      }
    } else {
      const returningCols = `m.${MAIL_ID}, x.${UID} as uid, m.read, m.saved, m.deleted, m.draft, m.answered, m.${MODSEQ} as modseq`;
      if (useUid) {
        const whereClause = `m.${USER_ID} = $1 AND m.${SENT} = $2
          AND x.${USER_ID} = m.${USER_ID} AND x.${MAILBOX} = $3 AND x.${MAIL_ID} = m.${MAIL_ID}
          AND x.${UID} >= $4 AND x.${UID} <= $5${membershipCondition(mailbox, sent, "m.")}`;
        selectSql = `SELECT ${returningCols} FROM mails m, ${MAIL_MAILBOX_UID} x WHERE ${whereClause}`;
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
        updateSql = `UPDATE mails m
          SET ${setClause}, updated = CURRENT_TIMESTAMP, ${MODSEQ} = $5
          FROM ${MAIL_MAILBOX_UID} x
          WHERE ${whereClause}${conditional ? ` AND m.${MODSEQ} <= $6` : ""}
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
      const rows = result.rows.map(toUpdatedMailFlags);
      if (!conditional) return { updated: rows, failed: [] };
      // A no-op still has to answer the UNCHANGEDSINCE question: a row the
      // client believes is older than it is must be reported in MODIFIED, not
      // silently counted as applied.
      return {
        updated: rows.filter((row) => row.modseq <= unchangedSince!),
        failed: rows.filter((row) => row.modseq > unchangedSince!).map((row) => row.uid),
      };
    }

    // One fresh mod-sequence for this STORE, stamped on every matched row so a
    // CONDSTORE client sees one modseq for the whole flag change (RFC 7162 §3.1
    // — a batch mutation may share a single mod-sequence). Reserved atomically so
    // concurrent STOREs get strictly-distinct, monotonic values.
    const modseq = await getNextModseq(user_id);

    if (!conditional) {
      const result = await pool.query(updateSql, [...baseValues, modseq]);
      return { updated: result.rows.map(toUpdatedMailFlags), failed: [] };
    }

    // The conditional path needs the set the range MATCHED, not just the set it
    // UPDATED, to name the losers in MODIFIED. Read the matched UIDs first, then
    // apply the guarded UPDATE; the difference is the failed set. Two round
    // trips only when the client asked for UNCHANGEDSINCE — the unconditional
    // STORE above still costs one.
    const matched = await pool.query(selectSql, baseValues);
    const result = await pool.query(updateSql, [...baseValues, modseq, unchangedSince]);
    const updated = result.rows.map(toUpdatedMailFlags);
    const updatedUids = new Set(updated.map((row) => row.uid));
    const failed = matched.rows
      .map((row) => Number(row.uid))
      .filter((uid) => !updatedUids.has(uid));
    return { updated, failed };
  } catch (error) {
    logger.error("Failed to set mail flags", {}, error);
    return { updated: [], failed: [] };
  }
};

const toUpdatedMailFlags = (row: Record<string, unknown>): UpdatedMailFlags => ({
  mail_id: row.mail_id as string,
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
    // EXPUNGE removes `\Deleted` messages *from the selected mailbox*, so a
    // mail the box does not show is out of reach here too — otherwise an INBOX
    // EXPUNGE would collect spam the client never saw and could not have flagged.
    const membership = membershipFilter(mailbox, sent);

    if (usesDomainUidSpace(mailbox)) {
      // Domain-wide expunge — still on uid_domain, unchanged.
      const rows = await mailsTable.updateWhere(
        {
          [USER_ID]: user_id,
          [SENT]: sent,
          [DELETED]: true,
          [EXPUNGED]: false,
          ...membership,
        },
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
        AND m.${DELETED} = TRUE AND m.${EXPUNGED} = FALSE${membershipCondition(mailbox, sent, "m.")}
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
    // Same membership rule as EXPUNGE: MOVE's source-side removal only ever
    // addresses UIDs the selected mailbox actually holds.
    const membership = membershipFilter(mailbox, sent);

    if (usesDomainUidSpace(mailbox)) {
      // Domain-wide: simple equality on user_id+sent + IN(uids).
      const rows = await mailsTable.updateWhere(
        {
          [USER_ID]: user_id,
          [SENT]: sent,
          [EXPUNGED]: false,
          [UID_DOMAIN]: { op: "IN", value: uids },
          ...membership,
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
        AND m.${EXPUNGED} = FALSE${membershipCondition(mailbox, sent, "m.")}
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
