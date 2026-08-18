import { logger } from "../../../logger";
import { pool } from "../../client";
import { ParamValue } from "../../database";
import {
  MailModel,
  MAIL_ID,
  USER_ID,
  READ,
  SAVED,
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
  IS_SPAM,
  INSIGHT,
} from "../../models";

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
  is_spam: boolean;
  insight: object | null;
}

export interface GetMailHeadersOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  // Restrict to spam-flagged received mail. Spam is a per-account folder like
  // received/sent, so it rides the same address-scoped query path.
  spam?: boolean;
  from?: number;
  size?: number;
  since?: string;
}

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
    READ, SAVED, SENT, IS_SPAM, INSIGHT,
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

  if (options.spam) {
    // Spam mail is always received, never sent — matches the (sent = FALSE)
    // guard the standalone spam query carried before spam became per-account.
    sql += ` AND is_spam = TRUE AND sent = FALSE`;
  } else {
    // Every non-spam view (New / All / Saved / Sent) is the complement of the
    // spam folder: a mail flagged spam — whether auto-classified on receipt or
    // marked by the user via /spam/mark — belongs only in the spam folder, not
    // here. Without this the "Mark as spam" action is cosmetic: the row would
    // reappear on the next refetch because the inbox query still returned it.
    sql += ` AND is_spam = FALSE`;
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
    // A row leaves the spam folder either by expunge OR by being un-marked
    // (is_spam flips to FALSE); both must tombstone so a cached client evicts
    // it. A non-spam view is the mirror: a row leaves it on expunge OR by being
    // marked spam (is_spam flips to TRUE), so a delta-sync client evicts a mail
    // the user just moved to the spam folder instead of leaving it cached.
    const evictionCondition = options.spam
      ? `(expunged = TRUE OR is_spam = FALSE)`
      : `(expunged = TRUE OR is_spam = TRUE)`;
    const expungedSql = `
      SELECT ${MAIL_ID} FROM mails
      WHERE user_id = $1
        AND ${addressCondition}
        AND ${evictionCondition}
        AND updated > $3
    `;

    const [headers, expungedResult] = await Promise.all([
      // Delta never paginates — the changed set is small and the client needs
      // every changed row, so from/size are deliberately omitted.
      getMailHeaders(user_id, address, {
        sent: options.sent,
        new: options.new,
        saved: options.saved,
        spam: options.spam,
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

const RECEIVED_ADDRESS_EXPANSION = `jsonb_array_elements(
  COALESCE(to_address, '[]'::jsonb) ||
  COALESCE(cc_address, '[]'::jsonb) ||
  COALESCE(bcc_address, '[]'::jsonb) ||
  COALESCE(envelope_to, '[]'::jsonb)
)->>'address' as address`;
const RECEIVED_ADDRESS_NOT_NULL = `(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL OR envelope_to IS NOT NULL)`;

export const getAccountStats = async (
  user_id: string,
  sent: boolean,
  domainFilter?: string,
  // Restrict to spam-flagged mail, so the per-account spam folder gets the same
  // address-grouped counts/badges as received. Spam is always received, so this
  // uses the received (to/cc/bcc/envelope_to) address expansion regardless of
  // `sent`.
  spamOnly = false
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
    const useSentExpansion = sent && !spamOnly;

    const addressExpansion = useSentExpansion
      ? `jsonb_array_elements(from_address)->>'address' as address`
      : RECEIVED_ADDRESS_EXPANSION;

    const addressNotNull = useSentExpansion
      ? `from_address IS NOT NULL`
      : RECEIVED_ADDRESS_NOT_NULL;

    // Match the per-account spam-folder query (is_spam received mail only).
    // Spam is a separate per-account folder: the spam view counts only is_spam
    // received mail; every other view (received/sent counts + New badge) is its
    // complement and must exclude is_spam, so the sidebar count matches the
    // spam-excluding headers list rather than over-counting by the spam total.
    const spamCondition = spamOnly
      ? `AND is_spam = TRUE AND sent = FALSE`
      : `AND is_spam = FALSE`;

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
          ${spamCondition}
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

// Received accounts that own at least one mail matching a full-text search
// term. Mirrors getAccountStats' received path (same address expansion +
// envelope_to union + domain filter) with the full-text predicate from
// searchMails added, so the search side-tab lists exactly the accounts whose
// mails appear in the search results — including sub-addressed deliveries the
// client payload can't see (envelope_to is server-only). counts/unread/saved
// reflect only the matching mails.
export const searchAccountStats = async (
  user_id: string,
  searchTerm: string,
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
    const domainCondition = domainFilter ? `AND address ILIKE '%@' || $3` : "";
    const sql = `
      WITH expanded_mails AS (
        SELECT DISTINCT
          mail_id, read, saved, date,
          ${RECEIVED_ADDRESS_EXPANSION}
        FROM mails
        WHERE user_id = $1
          AND expunged = FALSE
          AND draft = FALSE
          AND ${RECEIVED_ADDRESS_NOT_NULL}
          AND search_vector @@ plainto_tsquery('english', $2)
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
      ? [user_id, searchTerm, domainFilter]
      : [user_id, searchTerm];
    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      address: row.address as string,
      count: parseInt(row.count as string, 10),
      unread: parseInt(row.unread as string, 10),
      saved: parseInt(row.saved_count as string, 10),
      latest: new Date(row.latest as string),
    }));
  } catch (error) {
    logger.error("Failed to search account stats", {}, error);
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
      -- is_spam = FALSE: spam is quarantined to the spam folder, so it must not
      -- ring the new-mail badge either (same mirror — the New view excludes it).
      WHERE user_id IN (${placeholders}) AND sent = FALSE AND is_spam = FALSE AND expunged = FALSE AND draft = FALSE
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
