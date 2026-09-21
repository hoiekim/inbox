import { logger } from "../../../logger";
import { pool } from "../../client";
import {
  PartialMailModel,
  mailsTable,
  MAIL_ID,
  UID_DOMAIN,
  MODSEQ,
  EXPUNGED,
  DB_NOW,
} from "../../models";
import { getNextModseq } from "./counters";
import {
  buildAllUidsQuery,
  buildCountMessagesQuery,
  buildExpungeDeletedFilters,
  buildExpungeDeletedSelectQuery,
  buildExpungeUidsFilters,
  buildExpungeUidsSelectQuery,
  buildFirstUnseenUidQuery,
  buildMailsByRangeQuery,
  buildSearchMailsByUidQuery,
} from "./imap-query";
import { buildSetMailFlagsQueries } from "./set-flags-query";
import { singleFlight } from "./inflight";
import { usesDomainUidSpace } from "./views";

// Part of this module's public surface through the repository barrel; the
// definitions live beside the queries that consume them.
export { MATCH_NONE, buildCriterionClause } from "./imap-query";

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
): Promise<{ total: number; unread: number }> => {
  try {
    const { sql, values } = buildCountMessagesQuery(user_id, mailbox, sent);

    const result = await pool.query(sql, values);
    return {
      total: parseInt(result.rows[0]?.total || "0", 10),
      unread: parseInt(result.rows[0]?.unread || "0", 10),
    };
  } catch (error) {
    logger.error("Failed to count messages", {}, error);
    return { total: 0, unread: 0 };
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
    const { sql, values, selectedFields } = buildMailsByRangeQuery(
      user_id,
      mailbox,
      sent,
      start,
      end,
      useUid,
      fields,
      changedSince
    );

    const result = await pool.query(sql, values);
    const mails = new Map<string, PartialMailModel>();
    for (const row of result.rows) {
      mails.set(row.mail_id, new PartialMailModel(selectedFields, row));
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

    const { selectSql, matchedUidSql, updateSql, baseValues } = buildSetMailFlagsQueries(
      user_id,
      mailbox,
      sent,
      start,
      end,
      useUid,
      setClause,
      conditional
    );
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
    const matched = await pool.query(matchedUidSql, baseValues);
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


export const searchMailsByUid = async (
  user_id: string,
  mailbox: string | null,
  sent: boolean,
  criteria: { type: string; value?: unknown }[]
): Promise<number[]> => {
  try {
    const { sql, values } = buildSearchMailsByUidQuery(
      user_id,
      mailbox,
      sent,
      criteria
    );

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
    const { sql, values } = buildAllUidsQuery(user_id, mailbox, sent);

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
    const { sql, values } = buildFirstUnseenUidQuery(user_id, mailbox, sent);

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
    if (usesDomainUidSpace(mailbox)) {
      // Domain-wide expunge — still on uid_domain, unchanged.
      const rows = await mailsTable.updateWhere(
        buildExpungeDeletedFilters(user_id, mailbox, sent),
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
    const deletedQuery = buildExpungeDeletedSelectQuery(user_id, mailbox, sent);
    const selectResult = await pool.query(deletedQuery.sql, deletedQuery.values);
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
    if (usesDomainUidSpace(mailbox)) {
      // Domain-wide: simple equality on user_id+sent + IN(uids).
      const rows = await mailsTable.updateWhere(
        buildExpungeUidsFilters(user_id, mailbox, sent, uids),
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
    const uidsQuery = buildExpungeUidsSelectQuery(user_id, mailbox, sent, uids);
    const selectResult = await pool.query(uidsQuery.sql, uidsQuery.values);
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
