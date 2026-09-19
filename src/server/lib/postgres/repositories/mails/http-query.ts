/**
 * Every SQL statement the HTTP mail reads issue, built with no pool involved
 * so the emitted string and its bound parameters can be asserted directly.
 *
 * ```ts
 * const { sql, values } = buildMailHeadersQuery(user_id, address, options);
 * const result = await pool.query(sql, values);
 * ```
 */
import { ParamValue } from "../../database";
import {
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

// Seconds the delta cursor lags real time. `as_of` is backed off by this
// margin so a row mutated just before the read — the commit-latency window (a
// txn whose CURRENT_TIMESTAMP precedes our now() but commits after our SELECT),
// or one stamped under bounded app/DB clock skew — is re-sent on the NEXT call
// rather than skipped forever. Re-sends are deduped client-side by mail_id, so
// the cost is a small overlap, not duplicates. Must exceed expected commit
// latency + clock skew (NTP keeps the latter well under a second).
const DELTA_CURSOR_SAFETY_MARGIN_SECONDS = 2;

const RECEIVED_ADDRESS_EXPANSION = `jsonb_array_elements(
  COALESCE(to_address, '[]'::jsonb) ||
  COALESCE(cc_address, '[]'::jsonb) ||
  COALESCE(bcc_address, '[]'::jsonb) ||
  COALESCE(envelope_to, '[]'::jsonb)
)->>'address' as address`;
const RECEIVED_ADDRESS_NOT_NULL = `(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL OR envelope_to IS NOT NULL)`;

export const buildMailHeadersQuery = (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions
): { sql: string; values: ParamValue[] } => {
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
  return { sql, values };
};

export const buildDeltaAsOfQuery = (): {
  sql: string;
  values: ParamValue[];
} => ({
  sql: "SELECT now() - make_interval(secs => $1) AS as_of",
  values: [DELTA_CURSOR_SAFETY_MARGIN_SECONDS],
});

export const buildDeltaEvictionQuery = (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions,
  since: string
): { sql: string; values: ParamValue[] } => {
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
  return { sql: expungedSql, values: [user_id, addressJson, since] };
};

export const buildSearchMailsQuery = (
  user_id: string,
  searchTerm: string
): { sql: string; values: ParamValue[] } => {
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
  return { sql, values: [user_id, searchTerm] };
};

export const buildAccountStatsQuery = (
  user_id: string,
  sent: boolean,
  domainFilter: string | undefined,
  spamOnly: boolean
): { sql: string; values: ParamValue[] } => {
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
  return { sql, values };
};

export const buildSearchAccountStatsQuery = (
  user_id: string,
  searchTerm: string,
  domainFilter?: string
): { sql: string; values: ParamValue[] } => {
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
  return { sql, values };
};

// The empty-list guard lives at the call site: an empty placeholder list
// renders `IN ()`, which Postgres rejects.
export const buildUnreadNotificationsQuery = (
  user_ids: string[]
): { sql: string; values: ParamValue[] } => {
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
  return { sql, values: user_ids };
};
