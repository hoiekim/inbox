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

// Source-text scan for #507: getUnreadNotifications must exclude drafts
// so the push-payload badge_count matches the FE-polling badge count
// (getAccountStats excludes draft = FALSE via its expanded_mails CTE).
// Drift between the two queries inflated the iOS badge above the
// FE-shown unread count and produced a +1-per-new-mail symptom.
describe("getUnreadNotifications SQL filter", () => {
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const getUnreadNotifications[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getUnreadNotifications not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("excludes drafts (draft = FALSE) so badge matches FE polling (#507)", () => {
    expect(fnSource).toMatch(/draft\s*=\s*FALSE/);
  });

  it("preserves existing exclusions for sent + expunged", () => {
    expect(fnSource).toMatch(/sent\s*=\s*FALSE/);
    expect(fnSource).toMatch(/expunged\s*=\s*FALSE/);
  });

  it("counts only unread rows (read = FALSE) in the FILTER", () => {
    expect(fnSource).toMatch(/COUNT\(\*\)\s+FILTER\s*\(WHERE\s+read\s*=\s*FALSE\)/);
  });
});
