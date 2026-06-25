import crypto from "crypto";
import { logger } from "../../logger";
import { pool } from "../client";
import { ParamValue } from "../database";
import {
  MailModel,
  PartialMailModel,
  mailsTable,
  MAIL_ID,
  USER_ID,
  READ,
  SAVED,
  UID_DOMAIN,
  UID_ACCOUNT,
  TO_ADDRESS,
  FROM_ADDRESS,
  SUBJECT,
  DATE,
  FROM_TEXT,
  TO_TEXT,
  CC_ADDRESS,
  CC_TEXT,
  BCC_ADDRESS,
  BCC_TEXT,
  SENT,
  INSIGHT,
  ENVELOPE_TO,
  DELETED,
  EXPUNGED,
  MAIL_UID_COUNTERS,
  UID_KIND,
  UID_SCOPE,
  LAST_UID,
} from "../models";

/**
 * Represents the subset of mail fields returned by getMailHeaders.
 * This is a partial view that excludes body fields (html, text, attachments, etc.)
 * for performance reasons.
 */
export interface MailHeaderResult {
  mail_id: string;
  user_id: string;
  subject: string;
  date: string;
  from_address: object | null;
  from_text: string | null;
  to_address: object | null;
  to_text: string | null;
  cc_address: object | null;
  cc_text: string | null;
  bcc_address: object | null;
  bcc_text: string | null;
  read: boolean;
  saved: boolean;
  sent: boolean;
  insight: object | null;
}

export interface SaveMailInput {
  user_id: string;
  message_id: string;
  subject?: string;
  date?: string;
  html?: string;
  text?: string;
  from_address?: object | null;
  from_text?: string | null;
  to_address?: object | null;
  to_text?: string | null;
  cc_address?: object | null;
  cc_text?: string | null;
  bcc_address?: object | null;
  bcc_text?: string | null;
  reply_to_address?: object | null;
  reply_to_text?: string | null;
  envelope_from?: object | null;
  envelope_to?: object | null;
  attachments?: object | null;
  read?: boolean;
  saved?: boolean;
  sent?: boolean;
  deleted?: boolean;
  draft?: boolean;
  answered?: boolean;
  expunged?: boolean;
  insight?: object | null;
  uid_domain?: number;
  uid_account?: number;
  spam_score?: number;
  spam_reasons?: string[] | null;
  is_spam?: boolean;
}

export const saveMail = async (
  input: SaveMailInput
): Promise<{ _id: string } | undefined> => {
  try {
    const mail_id = crypto.randomUUID();
    const data: Record<string, ParamValue | object | null> = {
      mail_id,
      user_id: input.user_id,
      message_id: input.message_id,
      subject: input.subject ?? "",
      date: input.date ?? new Date().toISOString(),
      html: input.html ?? "",
      text: input.text ?? "",
      from_address: input.from_address ? JSON.stringify(input.from_address) : null,
      from_text: input.from_text ?? null,
      to_address: input.to_address ? JSON.stringify(input.to_address) : null,
      to_text: input.to_text ?? null,
      cc_address: input.cc_address ? JSON.stringify(input.cc_address) : null,
      cc_text: input.cc_text ?? null,
      bcc_address: input.bcc_address ? JSON.stringify(input.bcc_address) : null,
      bcc_text: input.bcc_text ?? null,
      reply_to_address: input.reply_to_address
        ? JSON.stringify(input.reply_to_address)
        : null,
      reply_to_text: input.reply_to_text ?? null,
      envelope_from: input.envelope_from
        ? JSON.stringify(input.envelope_from)
        : null,
      envelope_to: input.envelope_to ? JSON.stringify(input.envelope_to) : null,
      attachments: input.attachments ? JSON.stringify(input.attachments) : null,
      read: input.read ?? false,
      saved: input.saved ?? false,
      sent: input.sent ?? false,
      deleted: input.deleted ?? false,
      draft: input.draft ?? false,
      answered: input.answered ?? false,
      expunged: input.expunged ?? false,
      insight: input.insight ? JSON.stringify(input.insight) : null,
      uid_domain: input.uid_domain ?? 0,
      uid_account: input.uid_account ?? 0,
      spam_score: input.spam_score ?? 0,
      spam_reasons: input.spam_reasons ? JSON.stringify(input.spam_reasons) : null,
      is_spam: input.is_spam ?? false,
    };

    const row = await mailsTable.insert(data, [MAIL_ID]);
    if (row) return { _id: row[MAIL_ID] as string };
    return undefined;
  } catch (error: unknown) {
    // Unique constraint violation on (user_id, message_id):
    // This can happen legitimately when one email is delivered to multiple accounts
    // (e.g. account1@inbox.app, account2@inbox.app). The sender uses separate
    // envelopes, but the message_id is the same. In that case we must merge the
    // envelope_to values so we can correctly identify BCC recipients later.
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      const existing = await getMailByMessageId(input.user_id, input.message_id);
      if (!existing) return undefined;

      if (input.envelope_to) {
        type AddressEntry = { address?: string };
        const existingTo = (existing.envelope_to as AddressEntry[] | null) ?? [];
        const incomingTo = input.envelope_to as AddressEntry[];
        const seen = new Set(existingTo.map((a) => a.address));
        const merged = [
          ...existingTo,
          ...incomingTo.filter((a) => !seen.has(a.address)),
        ];
        await mailsTable.updateWhere(
          { user_id: input.user_id, message_id: input.message_id },
          { [ENVELOPE_TO]: JSON.stringify(merged) }
        );
      }

      return { _id: existing.mail_id };
    }

    logger.error("Failed to save mail", {}, error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
};

/**
 * Get a mail by user_id and message_id.
 * Used to find existing mail when a conflict occurs.
 */
export const getMailByMessageId = async (
  user_id: string,
  message_id: string
): Promise<MailModel | undefined> => {
  const result = await mailsTable.query({ user_id, message_id });
  return result[0];
};

export const getMailById = async (
  user_id: string,
  mail_id: string
): Promise<MailModel | null> => {
  try {
    return await mailsTable.queryOne({ [MAIL_ID]: mail_id, [USER_ID]: user_id });
  } catch (error) {
    logger.error("Failed to get mail by ID", {}, error);
    return null;
  }
};

export const markMailRead = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  try {
    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: mail_id, [USER_ID]: user_id },
      { read: true, updated: new Date() },
      [MAIL_ID]
    );
    return rows.length > 0;
  } catch (error) {
    logger.error("Failed to mark mail as read", {}, error);
    return false;
  }
};

export const markMailSaved = async (
  user_id: string,
  mail_id: string,
  saved: boolean
): Promise<boolean> => {
  try {
    const rows = await mailsTable.updateWhere(
      { [MAIL_ID]: mail_id, [USER_ID]: user_id },
      { saved, updated: new Date() },
      [MAIL_ID]
    );
    return rows.length > 0;
  } catch (error) {
    logger.error("Failed to mark mail as saved", {}, error);
    return false;
  }
};

export const deleteMail = async (
  user_id: string,
  mail_id: string
): Promise<boolean> => {
  try {
    const count = await mailsTable.deleteWhere({
      [MAIL_ID]: mail_id,
      [USER_ID]: user_id
    });
    return count > 0;
  } catch (error) {
    logger.error("Failed to delete mail", {}, error);
    return false;
  }
};

export interface GetMailHeadersOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  from?: number;
  size?: number;
  // ISO timestamp; when set, restrict to rows whose `updated` is newer than
  // this. Used by the IndexedDB-cache delta path (#457) to fetch only the
  // rows a cached client hasn't seen.
  since?: string;
}

// Builds the address-match SQL fragment for a per-account header query, bound
// to `$2` = the address-as-jsonb param. Shared by the full-list and the delta
// (getMailHeadersDelta) paths so the sent/received/saved address semantics
// can't drift between them.
//   - sent: match from_address only.
//   - received: match to_address, cc_address, bcc_address AND envelope_to.
//     `envelope_to` is the SMTP-level delivery address that can differ from
//     MIME to/cc/bcc under listserv-style routing (e.g. GitHub notifications:
//     MIME `to` = list address, envelope_to = the actual recipient
//     sub-address). Mirrors the received-branch expansion in `getAccountStats`
//     (PR #525) so an account row surfaced by envelope_to still resolves to
//     its mails when the user clicks through.
//   - saved (no explicit folder): a starred mail can be sent or received, so
//     the Saved view must span both branches. Without this, a starred *sent*
//     mail is unreachable from the Saved view — its account address only
//     matches from_address, never the received condition (#568).
export const buildHeaderAddressCondition = (
  options: Pick<GetMailHeadersOptions, "sent" | "saved">
): string => {
  const sentCondition = `${FROM_ADDRESS} @> $2::jsonb`;
  const receivedCondition = `(${TO_ADDRESS} @> $2::jsonb OR cc_address @> $2::jsonb OR bcc_address @> $2::jsonb OR envelope_to @> $2::jsonb)`;
  return options.saved && !options.sent
    ? `(${sentCondition} OR ${receivedCondition})`
    : options.sent
    ? sentCondition
    : receivedCondition;
};

export const getMailHeaders = async (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions
): Promise<MailHeaderResult[]> => {
  try {
    const addressJson = JSON.stringify([{ address }]);
    const addressCondition = buildHeaderAddressCondition(options);
    // Select only columns needed for mail headers — excludes html/text/attachments
    // to avoid loading full email bodies into memory for every concurrent request.
    const headerColumns = [
      MAIL_ID, USER_ID, SUBJECT, DATE,
      FROM_ADDRESS, FROM_TEXT,
      TO_ADDRESS, TO_TEXT,
      CC_ADDRESS, CC_TEXT,
      BCC_ADDRESS, BCC_TEXT,
      READ, SAVED, SENT, INSIGHT,
    ].join(", ");
    let sql = `
      SELECT ${headerColumns} FROM mails 
      WHERE user_id = $1 
        AND ${addressCondition}
        AND expunged = FALSE
        AND draft = FALSE
    `;
    const values: ParamValue[] = [user_id, addressJson];
    let paramIdx = 3;

    if (options.new) {
      sql += ` AND read = FALSE`;
    } else if (options.saved) {
      sql += ` AND saved = TRUE`;
    }

    if (options.since !== undefined) {
      sql += ` AND updated > $${paramIdx++}`;
      values.push(options.since);
    }

    sql += ` ORDER BY date DESC`;

    if (options.size !== undefined) {
      sql += ` LIMIT $${paramIdx++}`;
      values.push(options.size);
    }

    if (options.from !== undefined) {
      sql += ` OFFSET $${paramIdx}`;
      values.push(options.from);
    }

    const result = await pool.query(sql, values);
    return result.rows as MailHeaderResult[];
  } catch (error) {
    logger.error("Failed to get mail headers", {}, error);
    return [];
  }
};

export interface MailHeadersDeltaResult {
  as_of: string;
  headers: MailHeaderResult[];
  expunged_ids: string[];
}

// Seconds the delta cursor lags real time. `as_of` is backed off by this
// margin so a row mutated just before the read — the commit-latency window (a
// txn whose CURRENT_TIMESTAMP precedes our now() but commits after our SELECT),
// or one stamped under bounded app/DB clock skew — is re-sent on the NEXT call
// rather than skipped forever. Re-sends are deduped client-side by mail_id, so
// the cost is a small overlap, not duplicates. Must exceed expected commit
// latency + clock skew (NTP keeps the latter well under a second).
const DELTA_CURSOR_SAFETY_MARGIN_SECONDS = 2;

// Delta variant of getMailHeaders for the IndexedDB cache (#457): returns only
// rows changed since `since`, plus the ids of rows expunged within that window
// so a cached client can apply an incremental update and evict stale entries
// instead of refetching the whole folder.
//
// `as_of` is read from the DB clock BEFORE the data queries and backed off by
// DELTA_CURSOR_SAFETY_MARGIN_SECONDS, making it a safe lower bound: every
// mutation up to that instant is reflected here, and anything newer (or within
// the margin) is re-sent next call (at-least-once — the client dedups by id).
// Reading from the DB, not the app clock, keeps it on the same timeline as the
// `updated` column (set by CURRENT_TIMESTAMP on the flag-update paths).
// NOTE: the expunge path (expungeDeletedMails) currently stamps `updated` from
// the *app* clock (`new Date()`); the safety margin absorbs the resulting skew,
// but the rigorous fix is to move every `updated` write onto the DB clock —
// tracked as a follow-up. Fully eliminating the concurrent-commit window would
// further need an xid-snapshot cursor, beyond the approved Phase-1 timestamp
// contract.
//
// Tombstones (`expunged_ids`) cover EXPUNGED rows only — the approved Phase-1
// contract. In a filtered view (?new / ?saved) a row that LEAVES the filter
// (marked read, un-starred) drops out of `headers` but is NOT reported as a
// tombstone, so a client applying delta to a filtered view must full-revalidate
// it. The default (inbox/sent) view is fully correct. Generalizing this to an
// `evicted_ids` set is an open contract question for the Phase-2 client.
export const getMailHeadersDelta = async (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions,
  since: string
): Promise<MailHeadersDeltaResult> => {
  try {
    // The pool's TIMESTAMPTZ type parser (client.ts) already returns an ISO
    // string, the same representation the `updated` column carries — so this
    // value round-trips straight back as the next `?since=` cursor.
    const asOfResult = await pool.query<{ as_of: string }>(
      "SELECT now() - make_interval(secs => $1) AS as_of",
      [DELTA_CURSOR_SAFETY_MARGIN_SECONDS]
    );
    const as_of = asOfResult.rows[0].as_of;

    const addressJson = JSON.stringify([{ address }]);
    const addressCondition = buildHeaderAddressCondition(options);
    const expungedSql = `
      SELECT ${MAIL_ID} FROM mails
      WHERE user_id = $1
        AND ${addressCondition}
        AND expunged = TRUE
        AND updated > $3
    `;

    const [headers, expungedResult] = await Promise.all([
      // Delta never paginates — the changed set is small and the client needs
      // every changed row, so from/size are deliberately omitted.
      getMailHeaders(user_id, address, {
        sent: options.sent,
        new: options.new,
        saved: options.saved,
        since,
      }),
      pool.query<{ mail_id: string }>(expungedSql, [user_id, addressJson, since]),
    ]);

    return {
      as_of,
      headers,
      expunged_ids: expungedResult.rows.map((r) => r.mail_id),
    };
  } catch (error) {
    logger.error("Failed to get mail headers delta", {}, error);
    // Echo `since` back as as_of so a failed call doesn't advance the client's
    // cursor past unseen mutations.
    return { as_of: since, headers: [], expunged_ids: [] };
  }
};

export interface SearchMailModel extends MailModel {
  highlight?: {
    subject?: string[];
    text?: string[];
  };
  rank?: number;
}

export const searchMails = async (
  user_id: string,
  searchTerm: string,
  _field?: string
): Promise<SearchMailModel[]> => {
  try {
    // Use PostgreSQL full-text search with ranking and highlights
    const sql = `
      SELECT 
        *,
        ts_rank(search_vector, plainto_tsquery('english', $2)) as rank,
        ts_headline('english', subject, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as subject_highlight,
        ts_headline('english', text, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as text_highlight
      FROM mails
      WHERE user_id = $1
        AND search_vector @@ plainto_tsquery('english', $2)
        AND expunged = FALSE
        -- Drafts belong to the IMAP Drafts folder, not the search results;
        -- mirrors the draft filter on getMailHeaders / getAccountStats so a
        -- draft never surfaces in a view (search) that no folder/count shows.
        AND draft = FALSE
      ORDER BY rank DESC, date DESC
      LIMIT 1000
    `;

    interface SearchRow {
      rank: number;
      subject_highlight: string;
      text_highlight: string;
      [key: string]: unknown;
    }
    const result = await pool.query(sql, [user_id, searchTerm]);
    return result.rows.map((row: SearchRow) => {
      const model = new MailModel(row) as SearchMailModel;
      model.rank = row.rank;
      model.highlight = {};
      if (row.subject_highlight && row.subject_highlight.includes("<em>")) {
        model.highlight.subject = [row.subject_highlight];
      }
      if (row.text_highlight && row.text_highlight.includes("<em>")) {
        model.highlight.text = [row.text_highlight];
      }
      return model;
    });
  } catch (error) {
    logger.error("Failed to search mails", {}, error);
    return [];
  }
};

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
      WHERE user_id = $1 AND sent = $4
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
      WHERE user_id = $1
        AND ${addressCondition}
        AND sent = $4
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

export const getAccountStats = async (
  user_id: string,
  sent: boolean,
  domainFilter?: string
): Promise<
  {
    address: string;
    count: number;
    unread: number;
    saved: number;
    latest: Date;
  }[]
> => {
  try {
    // For sent mails, only look at from_address.
    // For received mails, union to_address + cc_address + bcc_address AND
    // envelope_to. `envelope_to` is the SMTP-level delivery address, which
    // can differ from MIME to/cc/bcc when a sender uses listserv-style
    // routing (e.g. GitHub notifications: MIME `to_text` =
    // `"hoiekim/budget" <budget@noreply.github.com>`, envelope_to =
    // `<sub-addr>@hoie.kim`). Without including envelope_to, mails
    // delivered via sub-addressing don't surface in the per-account
    // received view at all — but the push badge counts them, causing
    // FE shows 0 / badge shows N.
    const addressExpansion = sent
      ? `jsonb_array_elements(from_address)->>'address' as address`
      : `jsonb_array_elements(
          COALESCE(to_address, '[]'::jsonb) ||
          COALESCE(cc_address, '[]'::jsonb) ||
          COALESCE(bcc_address, '[]'::jsonb) ||
          COALESCE(envelope_to, '[]'::jsonb)
        )->>'address' as address`;

    const addressNotNull = sent
      ? `from_address IS NOT NULL`
      : `(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL OR envelope_to IS NOT NULL)`;

    // Use address matching (from_address for sent, to/cc/bcc for received) rather
    // than the `sent` boolean flag, so self-emails appear in both views correctly.
    const domainCondition = domainFilter
      ? `AND address ILIKE '%@' || $2`
      : "";

    // DISTINCT collapses rows where the same address appears more than once in
    // a single mail's recipient/sender list (e.g. LinkedIn duplicates the To
    // header), so each mail contributes once per address it actually involves.
    // The draft filter mirrors getMailHeaders so per-account badge counts match
    // the headers list view (drafts belong to the IMAP Drafts folder, not to
    // the per-account inbox view).
    const sql = `
      WITH expanded_mails AS (
        SELECT DISTINCT
          mail_id, read, saved, date,
          ${addressExpansion}
        FROM mails
        WHERE user_id = $1
          AND expunged = FALSE
          AND draft = FALSE
          AND ${addressNotNull}
      )
      SELECT
        address,
        COUNT(*) as count,
        SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN saved = TRUE THEN 1 ELSE 0 END) as saved_count,
        MAX(date) as latest
      FROM expanded_mails
      WHERE address IS NOT NULL
      ${domainCondition}
      GROUP BY address
      ORDER BY latest DESC
    `;
    const values: ParamValue[] = domainFilter
      ? [user_id, domainFilter]
      : [user_id];
    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      address: row.address as string,
      count: parseInt(row.count as string, 10),
      unread: parseInt(row.unread as string, 10),
      saved: parseInt(row.saved_count as string, 10),
      latest: new Date(row.latest as string),
    }));
  } catch (error) {
    logger.error("Failed to get account stats", {}, error);
    return [];
  }
};

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
 * Build SET clause for flag updates based on operation type.
 * Per RFC 3501 Section 6.4.6:
 * - FLAGS: Replace all flags with the provided list
 * - +FLAGS: Add the specified flags to existing flags
 * - -FLAGS: Remove the specified flags from existing flags
 */
function buildFlagSetClause(
  operation: StoreOperationType,
  flags: string[]
): string {
  const hasFlag = (flag: string) => flags.includes(flag);

  switch (operation) {
    case "FLAGS":
      // Replace mode: set all flags based on presence in flags array
      return `
        read = ${hasFlag("\\Seen")},
        saved = ${hasFlag("\\Flagged")},
        deleted = ${hasFlag("\\Deleted")},
        draft = ${hasFlag("\\Draft")},
        answered = ${hasFlag("\\Answered")}
      `;

    case "+FLAGS": {
      // Add mode: only set flags that are in the array to true
      const addClauses: string[] = [];
      if (hasFlag("\\Seen")) addClauses.push("read = TRUE");
      if (hasFlag("\\Flagged")) addClauses.push("saved = TRUE");
      if (hasFlag("\\Deleted")) addClauses.push("deleted = TRUE");
      if (hasFlag("\\Draft")) addClauses.push("draft = TRUE");
      if (hasFlag("\\Answered")) addClauses.push("answered = TRUE");
      // If no flags specified, return a no-op that still works
      return addClauses.length > 0 ? addClauses.join(", ") : "updated = updated";
    }

    case "-FLAGS": {
      // Remove mode: only set flags that are in the array to false
      const removeClauses: string[] = [];
      if (hasFlag("\\Seen")) removeClauses.push("read = FALSE");
      if (hasFlag("\\Flagged")) removeClauses.push("saved = FALSE");
      if (hasFlag("\\Deleted")) removeClauses.push("deleted = FALSE");
      if (hasFlag("\\Draft")) removeClauses.push("draft = FALSE");
      if (hasFlag("\\Answered")) removeClauses.push("answered = FALSE");
      // If no flags specified, return a no-op that still works
      return removeClauses.length > 0 ? removeClauses.join(", ") : "updated = updated";
    }

    default:
      // Default to replace mode
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

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      if (useUid) {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND sent = $2 AND ${uidField} >= $3 AND ${uidField} <= $4
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, start, end];
      } else {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE mail_id IN (
            SELECT mail_id FROM mails
            WHERE user_id = $1 AND sent = $2
            ORDER BY ${uidField} ASC
            OFFSET $3 LIMIT 1
          )
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, start];
      }
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb OR envelope_to @> $3::jsonb)`;
      if (useUid) {
        sql = `
          UPDATE mails
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            AND ${uidField} >= $4 AND ${uidField} <= $5
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, addressJson, start, end];
      } else {
        sql = `
          UPDATE mails 
          SET ${setClause}, updated = CURRENT_TIMESTAMP
          WHERE mail_id IN (
            SELECT mail_id FROM mails
            WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            ORDER BY ${uidField} ASC
            OFFSET $4 LIMIT 1
          )
          RETURNING ${uidField} as uid, read, saved, deleted, draft, answered
        `;
        values = [user_id, sent, addressJson, start];
      }
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      uid: row.uid as number,
      read: row.read as boolean,
      saved: row.saved as boolean,
      deleted: row.deleted as boolean,
      draft: row.draft as boolean,
      answered: row.answered as boolean,
    }));
  } catch (error) {
    logger.error("Failed to set mail flags", {}, error);
    return [];
  }
};

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

    // UID ranges (already split from UidCriterion in store.ts)
    case "UID_EXACT":
      values.push(criterion.value as number);
      return `${uidField} = $${values.length}`;
    case "UID_RANGE": {
      const range = criterion.value as { start: number; end: number };
      values.push(range.start, range.end);
      return `${uidField} >= $${values.length - 1} AND ${uidField} <= $${values.length}`;
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

export const getUnreadNotifications = async (
  user_ids: string[]
): Promise<Map<string, { count: number; latest?: Date }>> => {
  try {
    if (user_ids.length === 0) return new Map();

    const placeholders = user_ids.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `
      SELECT 
        user_id,
        COUNT(*) FILTER (WHERE read = FALSE) as unread_count,
        MAX(date) as latest
      FROM mails
      -- draft = FALSE: a user's own unsent draft must not ring the new-mail
      -- push badge. Mirrors getMailHeaders / getAccountStats so the badge count
      -- matches the headers list view (drafts live in the Drafts folder).
      WHERE user_id IN (${placeholders}) AND sent = FALSE AND expunged = FALSE AND draft = FALSE
      GROUP BY user_id
    `;

    const result = await pool.query(sql, user_ids);
    const notifications = new Map<string, { count: number; latest?: Date }>();

    for (const row of result.rows) {
      const count = parseInt(row.unread_count, 10);
      notifications.set(row.user_id, {
        count,
        latest: row.latest ? new Date(row.latest) : undefined,
      });
    }

    return notifications;
  } catch (error) {
    logger.error("Failed to get unread notifications", {}, error);
    return new Map();
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
        { [EXPUNGED]: true, updated: new Date() },
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
      { [EXPUNGED]: true, updated: new Date() },
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
        { [EXPUNGED]: true, updated: new Date() },
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
      { [EXPUNGED]: true, updated: new Date() },
      [`${uidField} as uid`]
    );
    return rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    logger.error("Failed to expunge mails by UID", { uids }, error);
    throw error;
  }
};

/**
 * Get all spam-flagged mails for a user.
 * Returns mails where is_spam = true, sorted by date descending.
 */
export const getSpamMails = async (user_id: string): Promise<MailModel[]> => {
  try {
    const sql = `
      SELECT * FROM mails
      -- draft = FALSE mirrors the other user-facing read paths: a draft belongs
      -- to the Drafts folder, never to the spam list, even if flagged is_spam.
      WHERE user_id = $1 AND is_spam = TRUE AND sent = FALSE AND expunged = FALSE AND draft = FALSE
      ORDER BY date DESC
    `;
    const result = await pool.query(sql, [user_id]);
    return result.rows.map((row: Record<string, unknown>) => new MailModel(row));
  } catch (error) {
    logger.error("Failed to get spam mails", {}, error);
    return [];
  }
};

/**
 * Mark or unmark a mail as spam.
 *
 * Returns:
 *   - `found`: true if the (user, mail) pair exists, regardless of current is_spam value
 *   - `changed`: true if the row's is_spam value was actually flipped
 *
 * Distinguishing "no change" from "not found" lets the caller skip classifier
 * training on idempotent re-marks while still surfacing real auth failures.
 */
export const markMailSpam = async (
  user_id: string,
  mail_id: string,
  is_spam: boolean
): Promise<{ found: boolean; changed: boolean }> => {
  try {
    const result = await pool.query(
      `UPDATE mails SET is_spam = $1, updated = NOW()
         WHERE mail_id = $2 AND user_id = $3 AND is_spam IS DISTINCT FROM $1
         RETURNING mail_id`,
      [is_spam, mail_id, user_id]
    );
    if ((result.rowCount ?? 0) > 0) return { found: true, changed: true };
    const exists = await pool.query(
      `SELECT 1 FROM mails WHERE mail_id = $1 AND user_id = $2 LIMIT 1`,
      [mail_id, user_id]
    );
    return { found: (exists.rowCount ?? 0) > 0, changed: false };
  } catch (error) {
    logger.error("Failed to mark mail as spam", {}, error);
    return { found: false, changed: false };
  }
};
