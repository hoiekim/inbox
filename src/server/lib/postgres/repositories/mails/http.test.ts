/**
 * Tests for mail repository functions
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";

describe("getAccountStats — envelope_to inclusion in received address expansion", () => {
  // Mails sent via listserv-style routing (e.g. GitHub notifications) carry
  // a MIME `to` header that points at the list address (e.g.
  // `<budget@noreply.github.com>`) and an SMTP-level `envelope_to` that
  // points at the actual recipient sub-address (e.g. `<x@hoie.kim>`). If
  // the received-side address expansion ignores envelope_to, those mails
  // never surface in the per-account view — but the push badge counts
  // them via the broader `getUnreadNotifications` query, so the FE shows
  // 0 unread while the iOS badge shows N. Verified against prod on
  // 2026-05-23: admin had badge=26 / FE=0 because 26 GitHub notification
  // mails carried envelope_to=claoie@hoie.kim but MIME to=noreply.github.
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
    const fnMatch = mailsSource.match(
      /export const getAccountStats[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getAccountStats not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("received-branch address expansion unions envelope_to with to/cc/bcc", () => {
    // The received-branch expansion lives in the shared
    // RECEIVED_ADDRESS_EXPANSION constant (reused by getAccountStats and
    // searchAccountStats so the two never drift). getAccountStats' received
    // branch must reference it.
    const constMatch = mailsSource.match(
      /const\s+RECEIVED_ADDRESS_EXPANSION\s*=\s*`([^`]*)`/
    );
    if (!constMatch) throw new Error("RECEIVED_ADDRESS_EXPANSION not found");
    const receivedSql = constMatch[1];
    expect(receivedSql).toContain("to_address");
    expect(receivedSql).toContain("cc_address");
    expect(receivedSql).toContain("bcc_address");
    expect(receivedSql).toContain("envelope_to");
    expect(fnSource).toContain("RECEIVED_ADDRESS_EXPANSION");
  });

  it("received-branch null-check includes envelope_to", () => {
    // Otherwise rows with only envelope_to populated (no MIME recipient
    // headers, which happens for some listserv-style senders) would be
    // filtered out before the address expansion even fires. Also a shared
    // constant so searchAccountStats inherits the same null-check.
    const constMatch = mailsSource.match(
      /const\s+RECEIVED_ADDRESS_NOT_NULL\s*=\s*`([^`]*)`/
    );
    if (!constMatch) throw new Error("RECEIVED_ADDRESS_NOT_NULL not found");
    const receivedSql = constMatch[1];
    expect(receivedSql).toContain("to_address IS NOT NULL");
    expect(receivedSql).toContain("envelope_to IS NOT NULL");
    expect(fnSource).toContain("RECEIVED_ADDRESS_NOT_NULL");
  });

  it("searchAccountStats reuses the shared received-address constants + full-text predicate", () => {
    // The search side-tab must list exactly the accounts whose mail appears in
    // the search results, so searchAccountStats' account attribution has to
    // match getAccountStats' received path (same envelope_to union) AND filter
    // to the search term via the same tsquery searchMails uses.
    const fnMatch = mailsSource.match(
      /export const searchAccountStats[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("searchAccountStats not found in mails/*.ts");
    const src = fnMatch[0];
    expect(src).toContain("RECEIVED_ADDRESS_EXPANSION");
    expect(src).toContain("RECEIVED_ADDRESS_NOT_NULL");
    expect(src).toContain("search_vector @@ plainto_tsquery('english', $2)");
    expect(src).toContain("expunged = FALSE");
    expect(src).toContain("draft = FALSE");
  });

  it("sent-branch address expansion remains from_address only", () => {
    // Don't accidentally widen the sent view — envelope_from has its own
    // semantics (bounce path) and isn't symmetric with envelope_to here.
    const exprMatch = fnSource.match(
      /const\s+addressExpansion\s*=\s*useSentExpansion\s*\?\s*`([^`]*)`/
    );
    if (!exprMatch) throw new Error("sent branch not found");
    const sentSql = exprMatch[1];
    expect(sentSql).toContain("from_address");
    expect(sentSql).not.toContain("envelope_to");
    expect(sentSql).not.toContain("envelope_from");
  });

  it("spamOnly forces the received expansion and filters is_spam", () => {
    // Spam is received mail grouped per receiving account, so spamOnly must
    // never take the sent (from_address) expansion, and must restrict to
    // is_spam received rows so the per-account spam counts match the folder.
    expect(fnSource).toContain("const useSentExpansion = sent && !spamOnly;");
    const spamMatch = fnSource.match(
      /const\s+spamCondition\s*=\s*spamOnly\s*\?\s*`([^`]*)`/
    );
    if (!spamMatch) throw new Error("spamCondition not found");
    expect(spamMatch[1]).toContain("is_spam = TRUE");
    expect(spamMatch[1]).toContain("sent = FALSE");
  });
});

describe("draft-exclusion invariant — user-facing read paths hide drafts (#611)", () => {
  // A draft lives in the IMAP Drafts folder; the web client presents no Drafts
  // view, so a draft must not surface in ANY user-facing read surface (folder
  // lists, per-account counts, search results, push badge, spam list). The
  // invariant is enforced query-side with `AND draft = FALSE`. getMailHeaders
  // and getAccountStats already carried it; searchMails / getUnreadNotifications
  // dropped it (#611) so a draft showed in search but in no folder/count. The
  // spam list is now a per-account getMailHeaders query (`?spam=1`), so its
  // draft filter is covered by the getMailHeaders guard below. These source-scan
  // guards pin the filter on every path so they cannot re-drift independently.
  // Source-text scanning (not a live query) is
  // used here because module-mock interactions make pool.query mocking fragile
  // in the full suite — same rationale as the getAccountStats guard above.
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
  });

  const bodyOf = (name: string): string => {
    const re = new RegExp(`export const ${name}[\\s\\S]*?\\n};`);
    const m = mailsSource.match(re);
    if (!m) throw new Error(`${name} not found in mails/*.ts`);
    return m[0];
  };

  // Every user-facing read path that must hide drafts.
  const draftHidingPaths = [
    "getMailHeaders",
    "getAccountStats",
    "searchMails",
    "getUnreadNotifications",
  ];

  for (const name of draftHidingPaths) {
    it(`${name} filters draft = FALSE`, () => {
      expect(bodyOf(name)).toMatch(/draft = FALSE/);
    });
  }

  it("searchMails keeps the draft filter alongside its existing expunged filter", () => {
    // Guard against a regression that removes one filter while editing the other.
    const body = bodyOf("searchMails");
    expect(body).toMatch(/expunged = FALSE/);
    expect(body).toMatch(/draft = FALSE/);
  });
});

describe("buildHeaderAddressCondition — envelope_to in received-branch address condition", () => {
  // Mails addressed via envelope_to (e.g. GitHub notification routing,
  // listserv sub-addressing) must appear in per-account mail lists, not
  // only in account-stats counts. The received-branch filter must include
  // envelope_to alongside MIME to/cc/bcc. The condition is shared by the
  // full-list (getMailHeaders) and delta (getMailHeadersDelta) paths via the
  // extracted buildHeaderAddressCondition helper, so this guards the one
  // source of truth.
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
    const fnMatch = mailsSource.match(
      /export const buildHeaderAddressCondition[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("buildHeaderAddressCondition not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("received branch's addressCondition unions envelope_to with to/cc/bcc", () => {
    // Source uses `${TO_ADDRESS}` template-literal substitution that
    // expands to "to_address" at runtime; the static text contains the
    // token, so the test asserts on the template tokens directly.
    const exprMatch = fnSource.match(
      /receivedCondition\s*=\s*`([^`]*)`/
    );
    if (!exprMatch) throw new Error("receivedCondition not found");
    const receivedSql = exprMatch[1];
    expect(receivedSql).toContain("${TO_ADDRESS}");
    expect(receivedSql).toContain("cc_address @>");
    expect(receivedSql).toContain("bcc_address @>");
    expect(receivedSql).toContain("envelope_to @>");
  });

  it("sent branch's addressCondition remains from_address only", () => {
    const exprMatch = fnSource.match(/sentCondition\s*=\s*`([^`]*)`/);
    if (!exprMatch) throw new Error("sentCondition not found");
    const sentSql = exprMatch[1];
    expect(sentSql).toContain("${FROM_ADDRESS}");
    expect(sentSql).not.toContain("envelope_to");
    expect(sentSql).not.toContain("envelope_from");
  });
});

describe("getMailHeaders / getMailHeadersDelta — `?since=` delta path (#457)", () => {
  // The delta path drives the IndexedDB cache: only rows changed since the
  // client's cursor, plus tombstones for rows expunged in that window. These
  // guard the SQL invariants that make the cursor safe — they can't be unit-
  // checked without a DB, so we assert on the query source (the repo's
  // established style for SQL-shape regressions).
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
  });

  it("getMailHeaders filters on `updated >` when options.since is set", () => {
    const fnMatch = mailsSource.match(/export const getMailHeaders[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("getMailHeaders not found");
    const src = fnMatch[0];
    // Guarded behind options.since so the full-list path is unaffected.
    expect(src).toContain("options.since !== undefined");
    expect(src).toContain("AND updated > $");
  });

  it("getMailHeadersDelta scans expunged rows for tombstones over the same window", () => {
    const fnMatch = mailsSource.match(
      /export const getMailHeadersDelta[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getMailHeadersDelta not found");
    const src = fnMatch[0];
    // Tombstone query: expunged rows in the same account, changed in-window.
    expect(src).toContain("expunged = TRUE");
    expect(src).toContain("AND updated > $3");
    // Reuses the one address-condition source of truth, not a private copy.
    expect(src).toContain("buildHeaderAddressCondition(options)");
  });

  it("getMailHeadersDelta reads as_of from the DB clock (with safety margin) BEFORE the data queries", () => {
    const fnMatch = mailsSource.match(
      /export const getMailHeadersDelta[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getMailHeadersDelta not found");
    const src = fnMatch[0];
    // as_of must come from now() (same timeline as the `updated` column set by
    // CURRENT_TIMESTAMP), not the app clock, or clock skew could skip rows.
    const asOfIdx = src.indexOf("now()");
    const headersIdx = src.indexOf("getMailHeaders(");
    expect(asOfIdx).toBeGreaterThanOrEqual(0);
    expect(headersIdx).toBeGreaterThanOrEqual(0);
    // Captured first → a safe lower bound (at-least-once on concurrent writes).
    expect(asOfIdx).toBeLessThan(headersIdx);
    // Backed off by a safety margin so the commit-latency / skew window re-sends
    // rather than skips.
    expect(src).toContain("make_interval(secs => $1)");
    expect(src).toContain("DELTA_CURSOR_SAFETY_MARGIN_SECONDS");
  });

  it("getMailHeadersDelta echoes `since` as as_of on failure (cursor must not advance)", () => {
    const fnMatch = mailsSource.match(
      /export const getMailHeadersDelta[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getMailHeadersDelta not found");
    const src = fnMatch[0];
    expect(src).toMatch(/return\s*\{\s*as_of:\s*since/);
  });
});

describe("getMailHeaders — saved query spans both folders (#568)", () => {
  // A starred mail can be either sent or received. A saved query with no
  // explicit folder must match an account address in EITHER from_address
  // (sent) or the received to/cc/bcc/envelope_to branch — otherwise a
  // starred sent mail is unreachable from the Saved view, the client-side
  // complement of #384's server fix.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
    const fnMatch = mailsSource.match(
      /export const buildHeaderAddressCondition[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("buildHeaderAddressCondition not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("uses the union (sent OR received) condition when saved && !sent", () => {
    const exprMatch = fnSource.match(
      /return\s+([\s\S]*?);/
    );
    if (!exprMatch) throw new Error("address-condition return expression not found");
    const expr = exprMatch[1];
    // The saved-and-not-sent branch is the union of both folder conditions.
    expect(expr).toContain("options.saved && !options.sent");
    expect(expr).toContain("sentCondition} OR ${receivedCondition");
  });

  it("falls back to the sent-only or received-only condition otherwise", () => {
    const exprMatch = fnSource.match(
      /return\s+([\s\S]*?);/
    );
    if (!exprMatch) throw new Error("address-condition return expression not found");
    const expr = exprMatch[1];
    expect(expr).toContain("options.sent");
    // Non-union branches reuse the single-folder conditions verbatim.
    expect(expr).toMatch(/\?\s*sentCondition/);
    expect(expr).toContain(": receivedCondition");
  });
});

describe("spam-exclusion invariant — non-spam views hide is_spam mail (#461)", () => {
  // The spam folder is a per-account view of is_spam = TRUE received mail. Its
  // complement — every non-spam view (New / All / Saved / Sent) — must hide any
  // is_spam mail, whether auto-classified on receipt or user-marked via
  // /spam/mark. Without this the "Mark as spam" button is cosmetic (the row
  // reappears on the next refetch) and auto-classified spam leaks into the
  // inbox. Source-scan style, matching the delta / draft-exclusion guards above.
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
  });

  it("getMailHeaders excludes is_spam mail from non-spam views", () => {
    const fnMatch = mailsSource.match(/export const getMailHeaders[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("getMailHeaders not found in mails/*.ts");
    const src = fnMatch[0];
    // Spam view includes is_spam = TRUE; the else (every other view) excludes it.
    expect(src).toMatch(/if \(options\.spam\)[\s\S]*is_spam = TRUE[\s\S]*else[\s\S]*is_spam = FALSE/);
  });

  it("getMailHeadersDelta evicts a mail from a non-spam view when it becomes spam", () => {
    const fnMatch = mailsSource.match(
      /export const getMailHeadersDelta[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getMailHeadersDelta not found in mails/*.ts");
    const src = fnMatch[0];
    // Non-spam eviction mirrors the spam side: tombstone on expunge OR when the
    // row is marked spam (is_spam flips to TRUE), so delta-sync clients evict it.
    const evictMatch = src.match(
      /evictionCondition\s*=\s*options\.spam[\s\S]*?:\s*`([^`]*)`/
    );
    if (!evictMatch) throw new Error("evictionCondition not found");
    expect(evictMatch[1]).toContain("expunged = TRUE");
    expect(evictMatch[1]).toContain("is_spam = TRUE");
  });
});

describe("getAccountStats + getUnreadNotifications — mirror the is_spam exclusion (#461)", () => {
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
  });

  it("getAccountStats excludes is_spam from the non-spam (received/sent) counts", () => {
    // The sidebar count must match the spam-excluding headers list, or an
    // account with spam would show a doc_count higher than its listed mails.
    const fnMatch = mailsSource.match(/export const getAccountStats[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("getAccountStats not found in mails/*.ts");
    const src = fnMatch[0];
    const spamMatch = src.match(
      /const\s+spamCondition\s*=\s*spamOnly[\s\S]*?:\s*`([^`]*)`/
    );
    if (!spamMatch) throw new Error("spamCondition not found");
    expect(spamMatch[1]).toContain("is_spam = FALSE");
  });

  it("getUnreadNotifications excludes is_spam so spam does not ring the new-mail badge", () => {
    const fnMatch = mailsSource.match(
      /export const getUnreadNotifications[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getUnreadNotifications not found in mails/*.ts");
    expect(fnMatch[0]).toContain("is_spam = FALSE");
  });
});
