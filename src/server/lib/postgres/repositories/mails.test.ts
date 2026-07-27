/**
 * Tests for mail repository functions
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";

describe("STORE operation types", () => {
  /**
   * Helper to simulate buildFlagSetClause behavior for testing.
   * This mirrors the logic in mails.ts
   */
  function simulateFlagUpdate(
    operation: "FLAGS" | "+FLAGS" | "-FLAGS",
    flags: string[],
    currentFlags: { read: boolean; saved: boolean; deleted: boolean; draft: boolean; answered: boolean }
  ): { read: boolean; saved: boolean; deleted: boolean; draft: boolean; answered: boolean } {
    const hasFlag = (flag: string) => flags.includes(flag);
    const result = { ...currentFlags };

    switch (operation) {
      case "FLAGS":
        // Replace mode: set all flags based on presence in flags array
        return {
          read: hasFlag("\\Seen"),
          saved: hasFlag("\\Flagged"),
          deleted: hasFlag("\\Deleted"),
          draft: hasFlag("\\Draft"),
          answered: hasFlag("\\Answered"),
        };

      case "+FLAGS":
        // Add mode: only set flags that are in the array to true
        if (hasFlag("\\Seen")) result.read = true;
        if (hasFlag("\\Flagged")) result.saved = true;
        if (hasFlag("\\Deleted")) result.deleted = true;
        if (hasFlag("\\Draft")) result.draft = true;
        if (hasFlag("\\Answered")) result.answered = true;
        return result;

      case "-FLAGS":
        // Remove mode: only set flags that are in the array to false
        if (hasFlag("\\Seen")) result.read = false;
        if (hasFlag("\\Flagged")) result.saved = false;
        if (hasFlag("\\Deleted")) result.deleted = false;
        if (hasFlag("\\Draft")) result.draft = false;
        if (hasFlag("\\Answered")) result.answered = false;
        return result;
    }
  }

  describe("FLAGS (replace mode)", () => {
    it("should replace all flags with specified flags", () => {
      const current = { read: true, saved: true, deleted: false, draft: false, answered: true };
      const result = simulateFlagUpdate("FLAGS", ["\\Seen", "\\Deleted"], current);
      expect(result).toEqual({
        read: true,
        saved: false,
        deleted: true,
        draft: false,
        answered: false,
      });
    });

    it("should clear all flags when empty flags list", () => {
      const current = { read: true, saved: true, deleted: true, draft: true, answered: true };
      const result = simulateFlagUpdate("FLAGS", [], current);
      expect(result).toEqual({
        read: false,
        saved: false,
        deleted: false,
        draft: false,
        answered: false,
      });
    });
  });

  describe("+FLAGS (add mode)", () => {
    it("should add flags without affecting others", () => {
      const current = { read: false, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Seen", "\\Deleted"], current);
      expect(result).toEqual({
        read: true,
        saved: true, // unchanged
        deleted: true,
        draft: false, // unchanged
        answered: false, // unchanged
      });
    });

    it("should not change flags when adding flags that are already set", () => {
      const current = { read: true, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Seen"], current);
      expect(result).toEqual({
        read: true,
        saved: true,
        deleted: false,
        draft: false,
        answered: false,
      });
    });

    it("should handle empty flags list without changes", () => {
      const current = { read: true, saved: false, deleted: false, draft: true, answered: false };
      const result = simulateFlagUpdate("+FLAGS", [], current);
      expect(result).toEqual(current);
    });
  });

  describe("-FLAGS (remove mode)", () => {
    it("should remove flags without affecting others", () => {
      const current = { read: true, saved: true, deleted: true, draft: false, answered: true };
      const result = simulateFlagUpdate("-FLAGS", ["\\Seen", "\\Answered"], current);
      expect(result).toEqual({
        read: false,
        saved: true, // unchanged
        deleted: true, // unchanged
        draft: false, // unchanged
        answered: false,
      });
    });

    it("should not change flags when removing flags that are already unset", () => {
      const current = { read: false, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("-FLAGS", ["\\Seen"], current);
      expect(result).toEqual({
        read: false,
        saved: true,
        deleted: false,
        draft: false,
        answered: false,
      });
    });

    it("should handle empty flags list without changes", () => {
      const current = { read: true, saved: false, deleted: false, draft: true, answered: false };
      const result = simulateFlagUpdate("-FLAGS", [], current);
      expect(result).toEqual(current);
    });
  });

  describe("real-world scenarios", () => {
    it("should handle marking as read", () => {
      const current = { read: false, saved: false, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Seen"], current);
      expect(result.read).toBe(true);
      expect(result.deleted).toBe(false); // Should not mark as deleted!
    });

    it("should handle marking for deletion without losing read status", () => {
      const current = { read: true, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Deleted"], current);
      expect(result).toEqual({
        read: true,
        saved: true,
        deleted: true,
        draft: false,
        answered: false,
      });
    });

    it("should handle undeleting a message", () => {
      const current = { read: true, saved: false, deleted: true, draft: false, answered: false };
      const result = simulateFlagUpdate("-FLAGS", ["\\Deleted"], current);
      expect(result.deleted).toBe(false);
      expect(result.read).toBe(true); // Should preserve read status
    });
  });
});

describe("buildFlagSetClause — empty/unknown-only STORE is a no-op (#671)", () => {
  // A +FLAGS/-FLAGS that touches no recognized flag must yield NO SET
  // assignment (empty string), not the old `updated = updated` sentinel that
  // collided with the trailing `updated = CURRENT_TIMESTAMP` → Postgres
  // "multiple assignments to same column". setMailFlags treats "" as the
  // legal no-op path (RFC 3501 §6.4.6).
  const load = async () => (await import("./mails")).buildFlagSetClause;

  it("returns '' for +FLAGS with an empty flag list", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("+FLAGS", [])).toBe("");
  });

  it("returns '' for -FLAGS with an empty flag list", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("-FLAGS", [])).toBe("");
  });

  it("returns '' for +FLAGS with only unknown/custom keywords", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("+FLAGS", ["\\CustomKeyword", "Foo"])).toBe("");
  });

  it("never emits the `updated = updated` double-assignment sentinel", async () => {
    const buildFlagSetClause = await load();
    for (const op of ["+FLAGS", "-FLAGS"] as const) {
      for (const flags of [[], ["Foo"], ["\\Seen"]]) {
        expect(buildFlagSetClause(op, flags)).not.toContain("updated");
      }
    }
  });

  it("still emits real column assignments when a flag is recognized", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("+FLAGS", ["\\Seen"])).toBe("read = TRUE");
    expect(buildFlagSetClause("+FLAGS", ["\\Seen", "\\Deleted"])).toBe(
      "read = TRUE, deleted = TRUE"
    );
    expect(buildFlagSetClause("-FLAGS", ["\\Flagged"])).toBe("saved = FALSE");
  });

  it("FLAGS replace mode is always a full (non-empty) assignment", async () => {
    const buildFlagSetClause = await load();
    // Even `FLAGS ()` (clear all) is a real change, never a no-op.
    const clause = buildFlagSetClause("FLAGS", []);
    expect(clause).toContain("read = false");
    expect(clause).toContain("answered = false");
  });
});

describe("setMailFlags — no-op STORE skips the UPDATE (source regression for #671)", () => {
  // Static source check (robust against module-mock interactions in the full
  // suite — see the #456 block above for the rationale): the no-op branch must
  // read current flags via SELECT without bumping `updated` or reserving a
  // mod-sequence, and the old colliding sentinel must be gone.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(/export const setMailFlags[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("setMailFlags not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("no longer contains the `updated = updated` sentinel", () => {
    expect(fnSource).not.toContain("updated = updated");
  });

  it("has a no-op branch guarded on an empty setClause", () => {
    expect(fnSource).toMatch(/if\s*\(!setClause\)/);
  });

  it("no-op branch uses SELECT, not UPDATE, so `updated`/modseq are untouched", () => {
    // The `!setClause` block runs a bare SELECT of the current flags.
    const noopBlock = fnSource.match(/if\s*\(!setClause\)\s*\{[\s\S]*?\n {4}\}/);
    expect(noopBlock).not.toBeNull();
    expect(noopBlock![0]).toContain("SELECT");
    expect(noopBlock![0]).not.toContain("UPDATE");
    expect(noopBlock![0]).not.toContain("getNextModseq");
  });
});

describe("expungeDeletedMails — `updated` column refresh (regression for #456)", () => {
  // Static source check: the expunge write paths must go through
  // mailsTable.updateWhere with `updated: new Date()` in the data bag so the
  // framework's own auto-`updated` is not bypassed. Source-text scanning is
  // robust against module-mock interactions in the full suite — the
  // alternative (mock pool.query) fails when other tests load mails.ts first.
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const expungeDeletedMails[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("expungeDeletedMails not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("does not contain any raw `SET expunged` UPDATE statement", () => {
    // Regression for #456: every write to `expunged` must go through the
    // framework so `updated` is bumped via the data bag. Raw SQL UPDATEs are
    // forbidden in this function.
    expect(fnSource).not.toMatch(/SET\s+expunged/);
  });

  it("domain-wide branch uses mailsTable.updateWhere with `updated`", () => {
    // The `account === null` branch must use updateWhere with equality filters.
    expect(fnSource).toContain("mailsTable.updateWhere(");
    expect(fnSource).toMatch(/\[EXPUNGED\]:\s*true/);
    expect(fnSource).toMatch(/updated:\s*new Date\(\)/);
  });

  it("account-specific branch uses mailsTable.updateWhere with IN filter", () => {
    // The `account !== null` branch is 2-step: raw SELECT to resolve mail_ids,
    // then framework updateWhere with op:"IN" so `updated` is bumped.
    expect(fnSource).toMatch(/op:\s*"IN"/);
    expect(fnSource).toMatch(/value:\s*mailIds/);
    // Two updateWhere call sites — one per branch.
    const updateWhereCount =
      (fnSource.match(/mailsTable\.updateWhere\(/g) ?? []).length;
    expect(updateWhereCount).toBe(2);
  });
});

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
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const getAccountStats[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getAccountStats not found in mails.ts");
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
    if (!fnMatch) throw new Error("searchAccountStats not found in mails.ts");
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
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
  });

  const bodyOf = (name: string): string => {
    const re = new RegExp(`export const ${name}[\\s\\S]*?\\n};`);
    const m = mailsSource.match(re);
    if (!m) throw new Error(`${name} not found in mails.ts`);
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

describe("buildCriterionClause — flag criteria use schema columns", () => {
  // Regression guard (originally on searchMailsByUid's inline switch, retargeted
  // here when #551 extracted the per-criterion logic into buildCriterionClause):
  // the answered/deleted/draft flags map to their real boolean columns, never to
  // a bare "FALSE" match-none sentinel that an earlier draft of this fix used.
  const clauseFor = async (type: string) => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    return buildCriterionClause({ type }, "uid_account", values as never);
  };

  it("ANSWERED maps to answered = TRUE", async () => {
    expect(await clauseFor("ANSWERED")).toBe("answered = TRUE");
  });

  it("UNANSWERED maps to answered = FALSE", async () => {
    expect(await clauseFor("UNANSWERED")).toBe("answered = FALSE");
  });

  it("DELETED maps to deleted = TRUE", async () => {
    expect(await clauseFor("DELETED")).toBe("deleted = TRUE");
  });

  it("UNDELETED maps to deleted = FALSE", async () => {
    expect(await clauseFor("UNDELETED")).toBe("deleted = FALSE");
  });

  it("DRAFT maps to draft = TRUE", async () => {
    expect(await clauseFor("DRAFT")).toBe("draft = TRUE");
  });

  it("UNDRAFT maps to draft = FALSE", async () => {
    expect(await clauseFor("UNDRAFT")).toBe("draft = FALSE");
  });

  it("no flag criterion returns a bare FALSE sentinel", async () => {
    for (const type of [
      "ANSWERED",
      "UNANSWERED",
      "DELETED",
      "UNDELETED",
      "DRAFT",
      "UNDRAFT",
    ]) {
      expect(await clauseFor(type)).not.toBe("FALSE");
    }
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
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const buildHeaderAddressCondition[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("buildHeaderAddressCondition not found in mails.ts");
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
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
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

describe("buildCriterionClause — NOT/OR SQL generation (regression for #551)", () => {
  // buildCriterionClause receives the normalised `{ type, value }` shape that
  // store.ts's simplifyCriterion produces. It pushes bound params onto `values`
  // (1-indexed `$N` tracks values.length) and returns the boolean SQL fragment,
  // or null when the criterion imposes no constraint.

  it("NOT wraps the inner clause instead of dropping it", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "SEEN" } },
      "uid_account",
      values as never
    );
    // Pre-fix this case had no `case "NOT"`/default, so the criterion fell
    // through the switch and contributed NOTHING — the query matched everything.
    expect(frag).toBe("NOT (read = TRUE)");
    expect(values).toHaveLength(0);
  });

  it("OR joins both sides with continuous param numbering", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "FROM", value: "alice" },
          right: { type: "FROM", value: "bob" },
        },
      },
      "uid_account",
      values as never
    );
    expect(frag).toBe("(from_text ILIKE $1 OR from_text ILIKE $2)");
    expect(values).toEqual(["%alice%", "%bob%"]);
  });

  it("NOT FROM negates a text predicate and binds its param", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "FROM", value: "spam@x" } },
      "uid_account",
      values as never
    );
    expect(frag).toBe("NOT (from_text ILIKE $1)");
    expect(values).toEqual(["%spam@x%"]);
  });

  it("continues param numbering from an already-populated values array", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = ["user-1", false]; // e.g. base user_id/sent params
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "SUBJECT", value: "a" },
          right: { type: "TO", value: "b" },
        },
      },
      "uid_account",
      values as never
    );
    expect(frag).toBe("(subject ILIKE $3 OR to_text ILIKE $4)");
    expect(values).toEqual(["user-1", false, "%a%", "%b%"]);
  });

  it("drops an OR whose side imposes no constraint rather than over-narrowing", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "FROM", value: "alice" },
          right: { type: "ALL" }, // ALL → null fragment
        },
      },
      "uid_account",
      values as never
    );
    // FROM alice OR ALL = everything, so the whole disjunction is dropped.
    expect(frag).toBeNull();
  });

  it("normalised NOT BEFORE flows a Date param through correctly", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const when = new Date("2026-01-01T00:00:00Z");
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "BEFORE", value: when } },
      "uid_account",
      values as never
    );
    expect(frag).toBe("NOT (date < $1)");
    expect(values).toEqual([when]);
  });

  it("plain criteria are unaffected by the refactor", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    expect(buildCriterionClause({ type: "SEEN" }, "uid_account", values as never)).toBe(
      "read = TRUE"
    );
    expect(buildCriterionClause({ type: "ALL" }, "uid_account", values as never)).toBeNull();
  });
});

describe("buildCriterionClause — UID_SET ORs its ranges (#659)", () => {
  // A UID sequence-set's ranges are alternatives, so they must OR among
  // themselves. Before #659 store.ts emitted one criterion per range and
  // searchMailsByUid ANDed them, so `1,3` became `uid = 1 AND uid = 3` — an
  // always-empty set. Now the whole set renders as a single OR-of-ranges.

  it("renders a single exact element without an OR wrapper", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 5 }] },
      "uid_account",
      values as never
    );
    expect(frag).toBe("uid_account = $1");
    expect(values).toEqual([5]);
  });

  it("ORs disjoint exact elements (`1,3`) instead of ANDing to empty", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      "uid_account",
      values as never
    );
    expect(frag).toBe("(uid_account = $1 OR uid_account = $2)");
    expect(values).toEqual([1, 3]);
  });

  it("ORs mixed exact + range elements (`2:3,5:7`) with parenthesised ranges", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 2, end: 3 }, { start: 5, end: 7 }] },
      "uid_account",
      values as never
    );
    expect(frag).toBe(
      "((uid_account >= $1 AND uid_account <= $2) OR (uid_account >= $3 AND uid_account <= $4))"
    );
    expect(values).toEqual([2, 3, 5, 7]);
  });

  it("renders a lone range without an OR wrapper (common `1:3` client form)", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1, end: 3 }] },
      "uid_account",
      values as never
    );
    expect(frag).toBe("(uid_account >= $1 AND uid_account <= $2)");
    expect(values).toEqual([1, 3]);
  });

  it("ANDs correctly against a sibling flag key (`SEEN 1,3`)", async () => {
    const { buildCriterionClause } = await import("./mails");
    // Sibling keys are joined with AND by searchMailsByUid; the set stays a
    // single OR-group so the intersection is `read AND (uid∈{1,3})`.
    const values: unknown[] = [];
    const flag = buildCriterionClause({ type: "SEEN" }, "uid_account", values as never);
    const set = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      "uid_account",
      values as never
    );
    expect([flag, set].join(" AND ")).toBe(
      "read = TRUE AND (uid_account = $1 OR uid_account = $2)"
    );
    expect(values).toEqual([1, 3]);
  });

  it("imposes no constraint for an empty set (caller skips it)", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    expect(
      buildCriterionClause({ type: "UID_SET", value: [] }, "uid_account", values as never)
    ).toBeNull();
    expect(values).toHaveLength(0);
  });
});

describe("searchMailsByUid — no result cap (#553)", () => {
  // A `LIMIT 10000` with `ORDER BY uid ASC` made SEARCH/UID SEARCH drop
  // the NEWEST messages once a mailbox exceeded 10000 — the worst-possible
  // truncation for an email client and an RFC 3501 §6.4.4 violation (SEARCH
  // must return all matching messages). The enumeration siblings getAllUids
  // and getMailsByRange are unbounded; the search path must match.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const searchMailsByUid[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("searchMailsByUid not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("the search SQL has no LIMIT clause", () => {
    const sqlMatch = fnSource.match(
      /const sql = `([\s\S]*?SELECT[\s\S]*?)`/
    );
    if (!sqlMatch) throw new Error("search SQL not found");
    expect(sqlMatch[1]).not.toMatch(/\bLIMIT\b/i);
  });
});

describe("buildCriterionClause — BODY/TEXT search the message body (#552)", () => {
  // RFC 3501 §6.4.4: BODY matches the message body; TEXT matches header +
  // body. The prior impl ORed only subject/from_text/to_text, so IMAP
  // `SEARCH BODY <s>` / `SEARCH TEXT <s>` never consulted the `text`
  // (plain-text body) column and missed virtually every body-content match.

  it("BODY matches the body column only", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "BODY", value: "needle" },
      "uid_account",
      values as never,
    );
    expect(frag).toBe("text ILIKE $1");
    // Body-only per RFC: must not fold in the header columns.
    expect(frag).not.toContain("subject ILIKE");
    expect(frag).not.toContain("from_text ILIKE");
    expect(values).toEqual(["%needle%"]);
  });

  it("TEXT matches header columns plus the body column", async () => {
    const { buildCriterionClause } = await import("./mails");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "TEXT", value: "needle" },
      "uid_account",
      values as never,
    );
    expect(frag).toContain("subject ILIKE");
    expect(frag).toContain("from_text ILIKE");
    expect(frag).toContain("to_text ILIKE");
    expect(frag).toContain("text ILIKE");
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
    const mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const buildHeaderAddressCondition[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("buildHeaderAddressCondition not found in mails.ts");
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
