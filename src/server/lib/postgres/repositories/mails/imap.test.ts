/**
 * Tests for mail repository functions
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";

describe("STORE operation types", () => {
  /**
   * Helper to simulate buildFlagSetClause behavior for testing.
   * This mirrors the logic in the mails/ repository
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
  const load = async () => (await import(".")).buildFlagSetClause;

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

describe("setMailFlags — no-op STORE skips the UPDATE (#671)", () => {
  // Not a SQL-shape guard: the property is which of the builder's two
  // statements the function chooses to run, which no emitted string can show.
  // `set-flags-query.test.ts` pins the SQL itself. Scoped to the one file the
  // function lives in — a whole-directory scan could match a decoy in another
  // module.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "imap.ts"),
      "utf8"
    );
    const fnMatch = source.match(/export const setMailFlags[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("setMailFlags not found in imap.ts");
    fnSource = fnMatch[0];
  });

  it("no longer contains the `updated = updated` sentinel", () => {
    expect(fnSource).not.toContain("updated = updated");
  });

  it("has a no-op branch guarded on an empty setClause", () => {
    expect(fnSource).toMatch(/if\s*\(!setClause\)/);
  });

  it("no-op branch runs the SELECT variant and never touches the UPDATE variant", () => {
    const noopBlock = fnSource.match(/if\s*\(!setClause\)\s*\{[\s\S]*?\n {4}\}/);
    expect(noopBlock).not.toBeNull();
    expect(noopBlock![0]).toContain("selectSql");
    expect(noopBlock![0]).not.toContain("updateSql");
    expect(noopBlock![0]).not.toContain("getNextModseq");
  });
});

describe("account-scoped reads use the raw mailbox path", () => {
  // Reads join mail_mailbox_uid on `x.mailbox = $N` where `$N` is the mailbox
  // path the caller passed in — the SAME string the write side stored via
  // writeMailboxUid. Deriving the JOIN target from the account address (e.g.
  // `INBOX/accounts/${localPart}`) breaks user-created mailboxes: `Archive`
  // stores rows with mail_mailbox_uid.mailbox = "Archive", so a derived
  // `INBOX/accounts/Archive` returns zero rows and the mail is invisible.
  //
  // Not SQL-shape guards — `imap-query.test.ts` asserts the emitted `x.mailbox
  // = $N` binding per branch. These two pin what no emitted string can show:
  // the absence of a derived-path helper, and the parameter name every reader
  // takes it under.
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
  });

  it("no longer defines the derived-path helper", () => {
    expect(mailsSource).not.toContain("mailboxPathForAccount");
  });

  const fns = [
    "countMessages",
    "getMailsByRange",
    "setMailFlags",
    "searchMailsByUid",
    "getAllUids",
    "getFirstUnseenUid",
    "expungeDeletedMails",
    "expungeMailsByUid",
  ];

  it.each(fns)("%s takes `mailbox` (not `account`) as the mapping key", (fn) => {
    // Extract the function's signature via the export line. Every refactored
    // reader must name its per-mailbox arg `mailbox` so future edits can't
    // rename it back to `account` (a legacy shape that implied a synthetic
    // address input, which is the pattern that caused the user-created bug).
    const sigMatch = mailsSource.match(
      new RegExp(`export const ${fn}\\s*=\\s*async\\s*\\(([\\s\\S]*?)\\)`)
    );
    expect(sigMatch, `signature not found for ${fn}`).not.toBeNull();
    expect(sigMatch![1]).toMatch(/\bmailbox\s*:\s*string\s*\|\s*null/);
    expect(sigMatch![1]).not.toMatch(/\baccount\s*:\s*string\s*\|\s*null/);
  });
});

describe("expungeDeletedMails — `updated` column refresh (#456, #614)", () => {
  // Not SQL-shape guards: `Table.updateWhere` builds the statement, so what
  // these pin is which API the mutation paths go through and that none of them
  // stamps `updated` from the app clock. The last of them is a repository-wide
  // absence, which is what the whole-directory read is for — a per-file scan
  // would miss the next module to reintroduce it.
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
      /export const expungeDeletedMails[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("expungeDeletedMails not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("does not contain any raw `SET expunged` UPDATE statement", () => {
    expect(fnSource).not.toMatch(/SET\s+expunged/);
  });

  it("domain-wide branch uses mailsTable.updateWhere with DB-clock `updated`", () => {
    // The `account === null` branch must use updateWhere with equality filters.
    expect(fnSource).toContain("mailsTable.updateWhere(");
    expect(fnSource).toMatch(/\[EXPUNGED\]:\s*true/);
    expect(fnSource).toMatch(/updated:\s*DB_NOW/);
    expect(fnSource).not.toMatch(/updated:\s*new Date\(\)/);
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

  it("no mutation path in mails.ts stamps `updated` from the app clock", () => {
    expect(mailsSource).not.toMatch(/updated:\s*new Date\(\)/);
    // And the sentinel is actually the shape in use.
    expect(mailsSource).toMatch(/updated:\s*DB_NOW/);
  });

  it("saveMail envelope_to merge (23505 conflict) stamps DB-clock `updated`", () => {
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const saveSource = saveMatch[0];
    expect(saveSource).toContain("mailsTable.updateWhere(");
    expect(saveSource).toMatch(/\[ENVELOPE_TO\]:/);
    expect(saveSource).toMatch(/updated:\s*DB_NOW/);
  });

  it("saveMail records its mapping rows through the decision helper on both branches", () => {
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const saveSource = saveMatch[0];
    // Which rows each branch writes is pinned by `mapping-decisions.test.ts`;
    // what this pins is that neither branch reaches `writeMailboxUid` around
    // it, which would put the gating back inline where nothing tests it.
    const decideCount = (saveSource.match(/decideMappingWrites\(\{/g) ?? []).length;
    expect(decideCount).toBe(2);
    expect(saveSource).not.toMatch(/writeMailboxUid\s*\(/);
  });

  it("saveMail's merge branch describes the SURVIVING row, never the caller's input", () => {
    // The caller's `uid_domain` belongs to an INSERT that never happened, and
    // its `sent` describes a different delivery of the same Message-ID. Both
    // have to come off `existing`, or a sent row acquires a received view's
    // membership at a UID drawn from the wrong counter.
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const mergeBranch = saveMatch[0].slice(saveMatch[0].indexOf('pgError.code === "23505"'));
    expect(mergeBranch).toMatch(/uid_domain:\s*existing\.uid_domain/);
    expect(mergeBranch).toMatch(/sent:\s*existing\.sent/);
    expect(mergeBranch).not.toMatch(/uid_domain:\s*input\.uid_domain/);
    expect(mergeBranch).not.toMatch(/sent:\s*input\.sent/);
  });

  it("saveMail's outer catch rethrows on non-23505 errors so SMTP replies 5xx", () => {
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const saveSource = saveMatch[0];
    // 23505 branch returns { _id }; the ONLY remaining `return undefined`
    // is the early-guard when getMailByMessageId misses (rare invariant
    // break, not a transient). The non-23505 outer-catch tail must throw.
    expect(saveSource).toMatch(/logger\.error\("Failed to save mail"/);
    // The line after "Failed to save mail" logger.error must be `throw error;`.
    const outerCatchTail = saveSource.match(
      /logger\.error\("Failed to save mail"[^\n]*\n\s+throw error;/
    );
    expect(outerCatchTail).not.toBeNull();
  });

  it("saveMail returns uid_mailbox on both the INSERT and the 23505 merge branches", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const core = await fs.readFile(
      path.join(import.meta.dir, "core.ts"),
      "utf8"
    );
    const saveMatch = core.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in core.ts");
    const saveSource = saveMatch[0];
    // The type annotation on saveMail's return promise must include
    // uid_mailbox as an optional field — callers depend on it for
    // COPYUID / MOVE dest-UID reporting (see storeMail's mail.uid.account
    // reconciliation).
    expect(saveSource).toMatch(/Promise<\{\s*_id:\s*string;\s*uid_mailbox\?/);
    // Both branches (INSERT success + 23505 merge) capture the UID persisted
    // for the mapped destination and thread it into the returned object.
    const persistedUidAssignments =
      (saveSource.match(/const persistedUid\s*=\s*await\s+recordMappings/g) ?? []).length;
    expect(persistedUidAssignments).toBe(2);
    // Both return statements include uid_mailbox: persistedUid.
    const returnSites = (saveSource.match(/return\s*\{\s*_id:[^}]*uid_mailbox:\s*persistedUid/g) ?? []).length;
    expect(returnSites).toBe(2);
  });
});

describe("buildCriterionClause — flag criteria use schema columns", () => {
  const clauseFor = async (type: string) => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    return buildCriterionClause({ type }, "uid_mailbox", values as never);
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

describe("buildCriterionClause — NOT/OR SQL generation (regression for #551)", () => {
  // buildCriterionClause receives the normalised `{ type, value }` shape that
  // store.ts's simplifyCriterion produces. It pushes bound params onto `values`
  // (1-indexed `$N` tracks values.length) and returns the boolean SQL fragment,
  // or null when the criterion imposes no constraint.

  it("NOT wraps the inner clause instead of dropping it", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "SEEN" } },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("NOT (read = TRUE)");
    expect(values).toHaveLength(0);
  });

  it("OR joins both sides with continuous param numbering", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "FROM", value: "alice" },
          right: { type: "FROM", value: "bob" },
        },
      },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(from_text ILIKE $1 OR from_text ILIKE $2)");
    expect(values).toEqual(["%alice%", "%bob%"]);
  });

  it("NOT FROM negates a text predicate and binds its param", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "FROM", value: "spam@x" } },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("NOT (from_text ILIKE $1)");
    expect(values).toEqual(["%spam@x%"]);
  });

  it("continues param numbering from an already-populated values array", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = ["user-1", false]; // e.g. base user_id/sent params
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "SUBJECT", value: "a" },
          right: { type: "TO", value: "b" },
        },
      },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(subject ILIKE $3 OR to_text ILIKE $4)");
    expect(values).toEqual(["user-1", false, "%a%", "%b%"]);
  });

  it("drops an OR whose side imposes no constraint rather than over-narrowing", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "FROM", value: "alice" },
          right: { type: "ALL" }, // ALL → null fragment
        },
      },
      "uid_mailbox",
      values as never
    );
    // FROM alice OR ALL = everything, so the whole disjunction is dropped.
    expect(frag).toBeNull();
  });

  it("normalised NOT BEFORE flows a Date param through correctly", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const when = new Date("2026-01-01T00:00:00Z");
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "BEFORE", value: when } },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("NOT (date < $1)");
    expect(values).toEqual([when]);
  });

  it("plain criteria are unaffected by the refactor", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    expect(buildCriterionClause({ type: "SEEN" }, "uid_mailbox", values as never)).toBe(
      "read = TRUE"
    );
    expect(buildCriterionClause({ type: "ALL" }, "uid_mailbox", values as never)).toBeNull();
  });
});

describe("buildCriterionClause — UID_SET ORs its ranges (#659)", () => {

  it("renders a single exact element without an OR wrapper", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 5 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("uid_mailbox = $1");
    expect(values).toEqual([5]);
  });

  it("ORs disjoint exact elements (`1,3`) instead of ANDing to empty", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(uid_mailbox = $1 OR uid_mailbox = $2)");
    expect(values).toEqual([1, 3]);
  });

  it("ORs mixed exact + range elements (`2:3,5:7`) with parenthesised ranges", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 2, end: 3 }, { start: 5, end: 7 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe(
      "((uid_mailbox >= $1 AND uid_mailbox <= $2) OR (uid_mailbox >= $3 AND uid_mailbox <= $4))"
    );
    expect(values).toEqual([2, 3, 5, 7]);
  });

  it("renders a lone range without an OR wrapper (common `1:3` client form)", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1, end: 3 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(uid_mailbox >= $1 AND uid_mailbox <= $2)");
    expect(values).toEqual([1, 3]);
  });

  it("ANDs correctly against a sibling flag key (`SEEN 1,3`)", async () => {
    const { buildCriterionClause } = await import(".");
    // Sibling keys are joined with AND by searchMailsByUid; the set stays a
    // single OR-group so the intersection is `read AND (uid∈{1,3})`.
    const values: unknown[] = [];
    const flag = buildCriterionClause({ type: "SEEN" }, "uid_mailbox", values as never);
    const set = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      "uid_mailbox",
      values as never
    );
    expect([flag, set].join(" AND ")).toBe(
      "read = TRUE AND (uid_mailbox = $1 OR uid_mailbox = $2)"
    );
    expect(values).toEqual([1, 3]);
  });

  it("imposes no constraint for an empty set (caller skips it)", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    expect(
      buildCriterionClause({ type: "UID_SET", value: [] }, "uid_mailbox", values as never)
    ).toBeNull();
    expect(values).toHaveLength(0);
  });
});

describe("buildCriterionClause — BODY/TEXT search the message body (#552)", () => {
  // RFC 3501 §6.4.4: BODY matches the message body; TEXT matches header +
  // body. The prior impl ORed only subject/from_text/to_text, so IMAP
  // `SEARCH BODY <s>` / `SEARCH TEXT <s>` never consulted the `text`
  // (plain-text body) column and missed virtually every body-content match.

  it("BODY matches the body column only", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "BODY", value: "needle" },
      "uid_mailbox",
      values as never,
    );
    expect(frag).toBe("text ILIKE $1");
    // Body-only per RFC: must not fold in the header columns.
    expect(frag).not.toContain("subject ILIKE");
    expect(frag).not.toContain("from_text ILIKE");
    expect(values).toEqual(["%needle%"]);
  });

  it("TEXT matches header columns plus the body column", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "TEXT", value: "needle" },
      "uid_mailbox",
      values as never,
    );
    expect(frag).toContain("subject ILIKE");
    expect(frag).toContain("from_text ILIKE");
    expect(frag).toContain("to_text ILIKE");
    expect(frag).toContain("text ILIKE");
  });
});

describe("buildCriterionClause — unexpressible criteria fail closed (#672)", () => {
  // Before this fix, any criterion the SQL backend couldn't express returned
  // null ("no constraint") and was dropped from the WHERE clause, so it matched
  // EVERY message (fail-open) — RFC 3501 §6.4.4 requires the exact match set,
  // and fail-open is the dangerous direction (a filter that should match none
  // returns all, and a client may bulk-move/flag/delete the whole mailbox).
  // The fix returns a MATCH_NONE sentinel ("FALSE") so the criterion fails
  // closed instead. KEYWORD/UNKEYWORD are exact evaluations (the server stores
  // no custom keywords); LARGER/SMALLER/arbitrary-HEADER are fail-closed until
  // backing data exists.
  const build = async (
    criterion: { type: string; value?: unknown },
    values: unknown[] = [],
  ) => {
    const { buildCriterionClause } = await import(".");
    return buildCriterionClause(criterion, "uid_mailbox", values as never);
  };

  it("MATCH_NONE is a truthy SQL fragment so searchMailsByUid keeps it in the AND", async () => {
    const { MATCH_NONE } = await import(".");
    // searchMailsByUid does `if (frag) conditions.push(frag)`. The sentinel must
    // stay truthy — an empty string would be dropped and re-open the fail-open hole.
    expect(MATCH_NONE).toBe("FALSE");
    expect(Boolean(MATCH_NONE)).toBe(true);
  });

  it("KEYWORD can never match (no custom keywords stored) → match-none", async () => {
    const values: unknown[] = [];
    expect(await build({ type: "KEYWORD", value: "Foo" }, values)).toBe("FALSE");
    expect(values).toHaveLength(0); // no bound param
  });

  it("UNKEYWORD always matches (no message has the keyword) → match-all (null)", async () => {
    expect(await build({ type: "UNKEYWORD", value: "Foo" })).toBeNull();
  });

  it("LARGER / SMALLER fail closed (RFC822.SIZE not persisted) → match-none", async () => {
    const lv: unknown[] = [];
    expect(await build({ type: "LARGER", value: 999999999 }, lv)).toBe("FALSE");
    expect(lv).toHaveLength(0);
    const sv: unknown[] = [];
    expect(await build({ type: "SMALLER", value: 1 }, sv)).toBe("FALSE");
    expect(sv).toHaveLength(0);
  });

  it("HEADER on an unsupported field fails closed → match-none", async () => {
    const values: unknown[] = [];
    expect(
      await build({ type: "HEADER", value: { field: "X-Mailer", text: "z" } }, values),
    ).toBe("FALSE");
    expect(values).toHaveLength(0);
  });

  it("HEADER on a supported field still filters (control — not swept into fail-closed)", async () => {
    const values: unknown[] = [];
    expect(
      await build({ type: "HEADER", value: { field: "Subject", text: "hi" } }, values),
    ).toBe("subject ILIKE $1");
    expect(values).toEqual(["%hi%"]);
  });

  it("an unknown criterion type fails closed → match-none", async () => {
    expect(await build({ type: "SOMETHING-UNSUPPORTED" })).toBe("FALSE");
  });

  it("`SEEN AND KEYWORD` — the KEYWORD fragment is FALSE so the AND matches nothing", async () => {
    // searchMailsByUid ANDs sibling fragments. SEEN → real column, KEYWORD → FALSE.
    expect(await build({ type: "SEEN" })).toBe("read = TRUE");
    expect(await build({ type: "KEYWORD", value: "Foo" })).toBe("FALSE");
    // Joined: "read = TRUE AND FALSE" → empty set (was "read = TRUE" alone before).
  });

  it("`OR SEEN KEYWORD` reduces to the constrained side (X OR none = X)", async () => {
    expect(
      await build({
        type: "OR",
        value: { left: { type: "SEEN" }, right: { type: "KEYWORD", value: "Foo" } },
      }),
    ).toBe("read = TRUE");
  });

  it("`OR KEYWORD KEYWORD` (both match-none) stays match-none", async () => {
    expect(
      await build({
        type: "OR",
        value: {
          left: { type: "KEYWORD", value: "A" },
          right: { type: "KEYWORD", value: "B" },
        },
      }),
    ).toBe("FALSE");
  });

  it("`OR SEEN ALL` still matches everything (match-all side wins — control)", async () => {
    expect(
      await build({
        type: "OR",
        value: { left: { type: "SEEN" }, right: { type: "ALL" } },
      }),
    ).toBeNull();
  });

  it("`NOT KEYWORD` = match-all (every message lacks the keyword)", async () => {
    expect(await build({ type: "NOT", value: { type: "KEYWORD", value: "Foo" } })).toBeNull();
  });

  it("`NOT ALL` = match-none (double-checks NOT of match-all)", async () => {
    expect(await build({ type: "NOT", value: { type: "ALL" } })).toBe("FALSE");
  });
});

describe("buildCriterionClause — combinators don't orphan bound params (#672)", () => {
  // Recursion pushes params onto the shared `values` as a side effect. When a
  // reduction discards a side that already pushed a param (e.g. an OR that
  // reduces to match-all because the OTHER side is ALL/UNKEYWORD), the discarded
  // param must be rolled back — otherwise values.length exceeds the max `$N`
  // referenced and Postgres rejects the Bind ("supplies N parameters, but
  // prepared statement requires M"), so searchMailsByUid throws and returns [].
  const build = async (
    criterion: { type: string; value?: unknown },
    values: unknown[],
  ) => {
    const { buildCriterionClause } = await import(".");
    return buildCriterionClause(criterion, "uid_mailbox", values as never);
  };

  it("`OR SUBJECT x ALL` → match-all, and rolls back SUBJECT's param", async () => {
    const values: unknown[] = ["user-1", false]; // base user_id/sent seed
    const frag = await build(
      { type: "OR", value: { left: { type: "SUBJECT", value: "x" }, right: { type: "ALL" } } },
      values,
    );
    expect(frag).toBeNull(); // X OR match-all = match-all
    expect(values).toEqual(["user-1", false]); // %x% rolled back — no orphan
  });

  it("`OR SUBJECT x UNKEYWORD Foo` → match-all, param rolled back (was a hard throw)", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "OR",
        value: { left: { type: "SUBJECT", value: "x" }, right: { type: "UNKEYWORD" } },
      },
      values,
    );
    expect(frag).toBeNull();
    expect(values).toEqual(["user-1", false]);
  });

  it("`OR ALL SUBJECT x` (null on the left) also rolls back", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      { type: "OR", value: { left: { type: "ALL" }, right: { type: "SUBJECT", value: "x" } } },
      values,
    );
    expect(frag).toBeNull();
    expect(values).toEqual(["user-1", false]);
  });

  it("`NOT (OR SUBJECT x ALL)` → match-none, nested param rolled back", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "NOT",
        value: {
          type: "OR",
          value: { left: { type: "SUBJECT", value: "x" }, right: { type: "ALL" } },
        },
      },
      values,
    );
    // inner OR = match-all (null) → NOT match-all = match-none.
    expect(frag).toBe("FALSE");
    expect(values).toEqual(["user-1", false]);
  });

  it("a real OR with two param-pushing sides keeps BOTH params, contiguously numbered", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "OR",
        value: { left: { type: "SUBJECT", value: "x" }, right: { type: "FROM", value: "y" } },
      },
      values,
    );
    expect(frag).toBe("(subject ILIKE $3 OR from_text ILIKE $4)");
    expect(values).toEqual(["user-1", false, "%x%", "%y%"]);
  });

  it("`X OR none` keeps X's param aligned (match-none side pushed nothing)", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "OR",
        value: { left: { type: "SUBJECT", value: "x" }, right: { type: "KEYWORD" } },
      },
      values,
    );
    expect(frag).toBe("subject ILIKE $3"); // KEYWORD = match-none → reduces to X
    expect(values).toEqual(["user-1", false, "%x%"]);
  });
});
