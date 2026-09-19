/**
 * SQL-shape guards for the HTTP mail reads, asserted on what the builders
 * emit rather than on the text of the functions that build it — the
 * convention `mail-modseq.test.ts` states: *"Pure `build*` helpers pin the SQL
 * shape with no pool interception."*
 *
 * A source-text guard recognises the spelling of a property, not the property,
 * so it is wrong in both directions: it rejects a reformat that emits the same
 * SQL, and it accepts an inverted predicate whose characters survive somewhere
 * in the file. These drive the builders and read the string Postgres would
 * receive.
 */

import { describe, it, expect } from "bun:test";
import {
  buildAccountStatsQuery,
  buildDeltaAsOfQuery,
  buildDeltaEvictionQuery,
  buildHeaderAddressCondition,
  buildMailHeadersQuery,
  buildSearchAccountStatsQuery,
  buildSearchMailsQuery,
  buildUnreadNotificationsQuery,
  type GetMailHeadersOptions,
} from "./http-query";

const USER = "11111111-1111-1111-1111-111111111111";
const ADDRESS = "a@example.com";

const headerOptions = (
  overrides: Partial<GetMailHeadersOptions> = {}
): GetMailHeadersOptions => ({
  sent: false,
  new: false,
  saved: false,
  ...overrides,
});

const headersSql = (overrides: Partial<GetMailHeadersOptions> = {}) =>
  buildMailHeadersQuery(USER, ADDRESS, headerOptions(overrides)).sql;

describe("buildHeaderAddressCondition", () => {
  it("unions envelope_to with to/cc/bcc on the received branch", () => {
    const condition = buildHeaderAddressCondition({ sent: false, saved: false });
    expect(condition).toContain("to_address @> $2::jsonb");
    expect(condition).toContain("cc_address @> $2::jsonb");
    expect(condition).toContain("bcc_address @> $2::jsonb");
    // Sub-addressed deliveries (listserv, GitHub notification routing) carry
    // no MIME recipient header, so without this they list nowhere.
    expect(condition).toContain("envelope_to @> $2::jsonb");
    expect(condition).not.toContain("from_address");
  });

  it("keeps the sent branch to from_address alone", () => {
    // envelope_from has bounce-path semantics and is not the mirror of
    // envelope_to, so widening the sent view to it would be wrong.
    const condition = buildHeaderAddressCondition({ sent: true, saved: false });
    expect(condition).toBe("from_address @> $2::jsonb");
  });

  it("unions both folder conditions for the saved view", () => {
    const saved = buildHeaderAddressCondition({ sent: false, saved: true });
    const sentOnly = buildHeaderAddressCondition({ sent: true, saved: false });
    const receivedOnly = buildHeaderAddressCondition({
      sent: false,
      saved: false,
    });
    expect(saved).toBe(`(${sentOnly} OR ${receivedOnly})`);
  });

  it("takes the sent branch when saved and sent are both set", () => {
    expect(buildHeaderAddressCondition({ sent: true, saved: true })).toBe(
      buildHeaderAddressCondition({ sent: true, saved: false })
    );
  });
});

describe("buildMailHeadersQuery", () => {
  it("hides drafts and expunged rows from every view", () => {
    for (const options of [
      {},
      { sent: true },
      { new: true },
      { saved: true },
      { spam: true },
    ]) {
      expect(headersSql(options)).toContain("AND draft = FALSE");
      expect(headersSql(options)).toContain("AND expunged = FALSE");
    }
  });

  it("restricts the spam view to is_spam received mail", () => {
    const sql = headersSql({ spam: true });
    expect(sql).toContain("AND is_spam = TRUE AND sent = FALSE");
    expect(sql).not.toContain("is_spam = FALSE");
  });

  it("excludes is_spam from every non-spam view", () => {
    // Without this the "Mark as spam" button is cosmetic: the row reappears on
    // the next refetch because the inbox query still returns it.
    for (const options of [{}, { sent: true }, { new: true }, { saved: true }]) {
      const sql = headersSql(options);
      expect(sql).toContain("AND is_spam = FALSE");
      expect(sql).not.toContain("is_spam = TRUE");
    }
  });

  it("filters on `updated >` only when a cursor is supplied", () => {
    expect(headersSql()).not.toContain("updated >");
    expect(headersSql({ since: "2026-01-01T00:00:00.000Z" })).toContain(
      "AND updated > $3"
    );
  });

  it("numbers since/size/from placeholders in step with the bound values", () => {
    // The cursor, page size and offset are appended in that order, so a
    // placeholder that drifts from its slot binds the wrong value — a page
    // size read as a timestamp, or an offset read as a page size.
    const { sql, values } = buildMailHeadersQuery(
      USER,
      ADDRESS,
      headerOptions({ since: "2026-01-01T00:00:00.000Z", size: 10, from: 5 })
    );
    expect(values).toEqual([
      USER,
      JSON.stringify([{ address: ADDRESS }]),
      "2026-01-01T00:00:00.000Z",
      10,
      5,
    ]);
    expect(sql).toContain("AND updated > $3");
    expect(sql).toContain("LIMIT $4");
    expect(sql).toContain("OFFSET $5");
  });

  it("closes the placeholder gap when the cursor is absent", () => {
    const { sql, values } = buildMailHeadersQuery(
      USER,
      ADDRESS,
      headerOptions({ size: 10, from: 5 })
    );
    expect(values).toHaveLength(4);
    expect(sql).toContain("LIMIT $3");
    expect(sql).toContain("OFFSET $4");
  });

  it("orders newest-first", () => {
    expect(headersSql()).toContain("ORDER BY date DESC");
  });
});

describe("buildDeltaAsOfQuery", () => {
  it("reads the cursor from the DB clock, backed off by a safety margin", () => {
    // The app clock is a different timeline from the `updated` column set by
    // CURRENT_TIMESTAMP, and the margin covers the commit-latency window: a
    // row committed just after our SELECT is re-sent next call rather than
    // skipped forever.
    const { sql, values } = buildDeltaAsOfQuery();
    expect(sql).toContain("now() - make_interval(secs => $1)");
    expect(sql).toContain("AS as_of");
    expect(values).toHaveLength(1);
    expect(values[0]).toBeGreaterThan(0);
  });
});

describe("buildDeltaEvictionQuery", () => {
  const evictionSql = (spam: boolean) =>
    buildDeltaEvictionQuery(
      USER,
      ADDRESS,
      headerOptions({ spam }),
      "2026-01-01T00:00:00.000Z"
    ).sql;

  it("tombstones expunged rows over the cursor window", () => {
    const sql = evictionSql(false);
    expect(sql).toContain("expunged = TRUE");
    expect(sql).toContain("AND updated > $3");
  });

  it("evicts a mail from a non-spam view when it becomes spam", () => {
    expect(evictionSql(false)).toContain("(expunged = TRUE OR is_spam = TRUE)");
  });

  it("evicts a mail from the spam view when it is un-marked", () => {
    expect(evictionSql(true)).toContain("(expunged = TRUE OR is_spam = FALSE)");
  });

  it("scopes tombstones to the same addresses the headers query lists", () => {
    // A tombstone for a mail the view never showed evicts a cache entry that
    // belongs to another account's list.
    const options = headerOptions();
    expect(evictionSql(false)).toContain(buildHeaderAddressCondition(options));
  });

  it("binds user, address and cursor in the order the placeholders name", () => {
    const { values } = buildDeltaEvictionQuery(
      USER,
      ADDRESS,
      headerOptions(),
      "2026-01-01T00:00:00.000Z"
    );
    expect(values).toEqual([
      USER,
      JSON.stringify([{ address: ADDRESS }]),
      "2026-01-01T00:00:00.000Z",
    ]);
  });
});

describe("buildSearchMailsQuery", () => {
  it("hides drafts and expunged rows from search results", () => {
    const { sql } = buildSearchMailsQuery(USER, "needle");
    expect(sql).toContain("AND expunged = FALSE");
    expect(sql).toContain("AND draft = FALSE");
  });

  it("matches on the full-text vector and binds the term once", () => {
    const { sql, values } = buildSearchMailsQuery(USER, "needle");
    expect(sql).toContain("search_vector @@ plainto_tsquery('english', $2)");
    expect(values).toEqual([USER, "needle"]);
  });
});

describe("buildAccountStatsQuery", () => {
  const statsSql = (sent: boolean, spamOnly = false, domain?: string) =>
    buildAccountStatsQuery(USER, sent, domain, spamOnly).sql;

  it("unions envelope_to into the received address expansion", () => {
    const sql = statsSql(false);
    expect(sql).toContain("COALESCE(to_address, '[]'::jsonb)");
    expect(sql).toContain("COALESCE(cc_address, '[]'::jsonb)");
    expect(sql).toContain("COALESCE(bcc_address, '[]'::jsonb)");
    expect(sql).toContain("COALESCE(envelope_to, '[]'::jsonb)");
  });

  it("includes envelope_to in the received null-check", () => {
    // Otherwise a row carrying only envelope_to is filtered out before the
    // address expansion even fires.
    expect(statsSql(false)).toContain("envelope_to IS NOT NULL");
  });

  it("keeps the sent expansion to from_address alone", () => {
    const sql = statsSql(true);
    expect(sql).toContain("jsonb_array_elements(from_address)->>'address'");
    expect(sql).toContain("from_address IS NOT NULL");
    expect(sql).not.toContain("envelope_to");
    expect(sql).not.toContain("envelope_from");
  });

  it("forces the received expansion for the spam folder even when sent is set", () => {
    // Spam is received mail grouped per receiving account, so it must never
    // take the from_address expansion.
    const sql = statsSql(true, true);
    expect(sql).toContain("COALESCE(envelope_to, '[]'::jsonb)");
    expect(sql).not.toContain("jsonb_array_elements(from_address)");
  });

  it("counts is_spam rows only for the spam folder", () => {
    expect(statsSql(false, true)).toContain("AND is_spam = TRUE AND sent = FALSE");
    // The sidebar count has to match the spam-excluding headers list, or an
    // account with spam shows a doc_count higher than its listed mails.
    expect(statsSql(false, false)).toContain("AND is_spam = FALSE");
    expect(statsSql(true, false)).toContain("AND is_spam = FALSE");
  });

  it("hides drafts and expunged rows", () => {
    for (const sent of [false, true]) {
      expect(statsSql(sent)).toContain("AND expunged = FALSE");
      expect(statsSql(sent)).toContain("AND draft = FALSE");
    }
  });

  it("binds the domain filter only when one is supplied", () => {
    const withDomain = buildAccountStatsQuery(USER, false, "example.com", false);
    expect(withDomain.sql).toContain("AND address ILIKE '%@' || $2");
    expect(withDomain.values).toEqual([USER, "example.com"]);

    const without = buildAccountStatsQuery(USER, false, undefined, false);
    expect(without.sql).not.toContain("ILIKE");
    expect(without.values).toEqual([USER]);
  });
});

describe("buildSearchAccountStatsQuery", () => {
  it("reuses the received expansion and null-check getAccountStats emits", () => {
    // The search side-tab must list exactly the accounts whose mail appears in
    // the results, so its account attribution cannot drift from the received
    // path's.
    const { sql } = buildSearchAccountStatsQuery(USER, "needle");
    const received = buildAccountStatsQuery(USER, false, undefined, false).sql;
    const expansion = received.slice(
      received.indexOf("jsonb_array_elements("),
      received.indexOf("as address") + "as address".length
    );
    expect(expansion).toContain("envelope_to");
    expect(sql).toContain(expansion);
    expect(sql).toContain(
      "(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL OR envelope_to IS NOT NULL)"
    );
  });

  it("filters to the search term with the predicate searchMails uses", () => {
    const { sql, values } = buildSearchAccountStatsQuery(USER, "needle");
    expect(sql).toContain("search_vector @@ plainto_tsquery('english', $2)");
    expect(sql).toContain("AND expunged = FALSE");
    expect(sql).toContain("AND draft = FALSE");
    expect(values).toEqual([USER, "needle"]);
  });

  it("binds the domain filter after the search term", () => {
    const { sql, values } = buildSearchAccountStatsQuery(
      USER,
      "needle",
      "example.com"
    );
    expect(sql).toContain("AND address ILIKE '%@' || $3");
    expect(values).toEqual([USER, "needle", "example.com"]);
  });
});

describe("buildUnreadNotificationsQuery", () => {
  it("excludes spam, drafts, sent and expunged mail from the badge", () => {
    const { sql } = buildUnreadNotificationsQuery([USER]);
    expect(sql).toContain("is_spam = FALSE");
    expect(sql).toContain("draft = FALSE");
    expect(sql).toContain("sent = FALSE");
    expect(sql).toContain("expunged = FALSE");
  });

  it("renders one placeholder per user and binds them in order", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    const { sql, values } = buildUnreadNotificationsQuery([USER, other]);
    expect(sql).toContain("user_id IN ($1, $2)");
    expect(values).toEqual([USER, other]);
  });

  it("counts unread rows per user rather than all rows", () => {
    const { sql } = buildUnreadNotificationsQuery([USER]);
    expect(sql).toContain("COUNT(*) FILTER (WHERE read = FALSE)");
    expect(sql).toContain("GROUP BY user_id");
  });
});
