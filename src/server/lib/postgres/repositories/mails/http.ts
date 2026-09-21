import { logger } from "../../../logger";
import { pool } from "../../client";
import { MailModel } from "../../models";
import {
  GetMailHeadersOptions,
  buildAccountStatsQuery,
  buildDeltaAsOfQuery,
  buildDeltaEvictionQuery,
  buildMailHeadersQuery,
  buildSearchAccountStatsQuery,
  buildSearchMailsQuery,
  buildUnreadNotificationsQuery,
} from "./http-query";

export type { GetMailHeadersOptions };

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

export const getMailHeaders = async (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions
): Promise<MailHeaderResult[]> => {
  const { sql, values } = buildMailHeadersQuery(user_id, address, options);
  const result = await pool.query(sql, values);
  return result.rows as MailHeaderResult[];
};

export interface MailHeadersDeltaResult {
  as_of: string;
  headers: MailHeaderResult[];
  expunged_ids: string[];
}

// Delta variant of getMailHeaders for the IndexedDB cache: returns only rows
// changed since `since`, plus the ids of rows expunged within that window so a
// cached client can apply an incremental update and evict stale entries.
//
// `as_of` is read from the DB clock BEFORE the data queries and backed off by
// DELTA_CURSOR_SAFETY_MARGIN_SECONDS, making it a safe lower bound: any
// mutation newer than that (or within the margin) is re-sent next call
// (at-least-once — the client dedups by id). Reading the DB clock keeps this
// on the same timeline as the `updated` column set by CURRENT_TIMESTAMP.
//
// Tombstones (`expunged_ids`) cover EXPUNGED rows only. In a filtered view
// (?new / ?saved) a row that LEAVES the filter (marked read, un-starred)
// drops out of `headers` but is NOT reported as a tombstone, so a client
// applying delta to a filtered view must full-revalidate it. The default
// inbox/sent view is fully correct.
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
    const asOf = buildDeltaAsOfQuery();
    const asOfResult = await pool.query<{ as_of: string }>(
      asOf.sql,
      asOf.values
    );
    const as_of = asOfResult.rows[0].as_of;

    const eviction = buildDeltaEvictionQuery(user_id, address, options, since);

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
      pool.query<{ mail_id: string }>(eviction.sql, eviction.values),
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
    const { sql, values } = buildSearchMailsQuery(user_id, searchTerm);

    interface SearchRow {
      rank: number;
      subject_highlight: string;
      text_highlight: string;
      [key: string]: unknown;
    }
    const result = await pool.query(sql, values);
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
    const { sql, values } = buildAccountStatsQuery(
      user_id,
      sent,
      domainFilter,
      spamOnly
    );
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
    const { sql, values } = buildSearchAccountStatsQuery(
      user_id,
      searchTerm,
      domainFilter
    );
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

    const { sql, values } = buildUnreadNotificationsQuery(user_ids);
    const result = await pool.query(sql, values);
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
