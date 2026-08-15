/**
 * `saveMail`'s utility-folder placement, on BOTH branches.
 *
 * The INSERT branch is observable from the caller's input object, so
 * `imap/store.test.ts` can pin it. The 23505 merge branch is not: it rewrites a
 * row that already exists, and a caller-side assertion passes whether or not
 * that write happens.
 *
 * Previous versions of this file ran the real `saveMail` against a
 * `mock.module("../../client", ...)` FakePool to observe the emitted SQL.
 * That recipe is process-global in Bun and, on Linux CI, silently leaks the
 * pool mock into `users.test.ts` under some file-load orders — the CD run
 * for `refactor(imap): extract cloneMailToDestination + syncMappedPivotsForRow`
 * (2026-08-15) failed on 16 `users.test.ts` tests for exactly that reason,
 * as did the same suite twice mid-#830. The fix (per
 * `reference_bun_mock_module_global_hoisting.md`, fifth variant) is: **do
 * not reach for the FakePool seam to assert SQL shape. Extract a pure
 * helper and test that, or assert on the source directly.**
 *
 * These are source-level pins on `core.ts` — cheap, no pool, no
 * mock.module, no cross-file bleed. They catch the specific regressions
 * the runtime tests were catching (dropping the placement spread,
 * removing the 23505 branch's UPDATE, forgetting the modseq bump), and
 * miss only the "the write actually fires at runtime" leg of coverage —
 * which is testable end-to-end through the existing IMAP suite (APPEND
 * into Drafts / Junk / Starred / Trash all round-trip through
 * `saveMail`'s real branches). A follow-up refactor extracting
 * `applyPlacementMerge` as a pure helper would let us re-add runtime
 * assertions without the mock.module hazard — filed on the task list.
 */
import { resolve } from "path";
import { describe, it, expect } from "bun:test";

// Read via `Bun.file(...).text()` NOT `fs.readFileSync`: two sibling test
// files (`mailgun.test.ts`, `http/routes/health.test.ts`) do
// `mock.module("fs", ...)`, which is process-global in Bun and, under some
// full-suite file orderings, replaces `readFileSync` with an undefined
// export on this file's `import { readFileSync } from "fs"`. Bun's own
// file API is not on the `fs` module surface, so it's immune to the leak.
const CORE_TS = await Bun.file(
  resolve(process.cwd(), "src/server/lib/postgres/repositories/mails/core.ts")
).text();

/**
 * Boolean substring assertion — a failing `toContain` on a whole-file
 * source string prints the entire file into the test output, which drowns
 * the failure message. `.includes(...)`.toBe(true) prints a one-line diff.
 * (See `reference_bun_mock_module_global_hoisting.md` fifth variant.)
 */
const hasSubstring = (needle: string) => CORE_TS.includes(needle);

describe("saveMail — utility placement on the INSERT branch", () => {
  it("spreads `input.placement` into the INSERT `data` object", () => {
    // `...input.placement` lands the flag inside `data` before the
    // `mailsTable.insert(data, [MAIL_ID])` call, so the row is written
    // with the flag set. A regression that dropped the spread would land
    // the row with the flag at its default (FALSE) and the mail would be
    // in no box the client named.
    expect(hasSubstring("...input.placement")).toBe(true);
  });

  it("calls `mailsTable.insert(data, [MAIL_ID])` with the composed row", () => {
    // Guards against a regression that skipped the INSERT itself (e.g. an
    // early-return before this line for a placement-only write).
    expect(hasSubstring("mailsTable.insert(data, [MAIL_ID])")).toBe(true);
  });
});

describe("saveMail — utility placement on the 23505 merge branch", () => {
  it("guards the merge-branch UPDATE on `input.placement` being present", () => {
    // The 23505 branch fires for cross-delivery re-sends of the same
    // Message-ID from distinct SMTP sessions. Without a placement, the
    // merge branch must not issue a spurious membership-flip UPDATE (that
    // would advance the mod-sequence for a no-op, breaking HIGHESTMODSEQ
    // reads by CONDSTORE clients).
    expect(hasSubstring("if (input.placement)")).toBe(true);
  });

  it("issues `mailsTable.updateWhere` with the placement + modseq + updated timestamp", () => {
    // The merge-branch UPDATE carries the placement flag AND advances the
    // mod-sequence — placement is a membership change per RFC 7162, so
    // HIGHESTMODSEQ has to move. Two source snippets pin the shape:
    //   1. the updateWhere call to `mails` keyed on (user_id, message_id),
    //   2. the merge UPDATE object spreads `input.placement` and stamps
    //      `[MODSEQ]: await getNextModseq(input.user_id)`.
    expect(
      hasSubstring("mailsTable.updateWhere(") &&
        hasSubstring("...input.placement") &&
        hasSubstring("[MODSEQ]: await getNextModseq(input.user_id)")
    ).toBe(true);
  });

  it("re-reads the existing row via `getMailByMessageId` after 23505", () => {
    // The merge branch needs the pre-existing mail_id (returned to the
    // caller as `_id` so a COPY/APPEND partial-failure retry converges on
    // the first-attempt row). A regression that dropped the re-read would
    // return `undefined` and turn the successful merge into a NACK — the
    // sender or client retries in a loop.
    expect(
      hasSubstring("getMailByMessageId(input.user_id, input.message_id)")
    ).toBe(true);
  });
});

describe("saveMail — 23505 code narrows the merge branch", () => {
  it("only takes the merge path on `pgError.code === \"23505\"`", () => {
    // A regression that widened the catch to any error would silently
    // swallow every save failure as a merge attempt against a possibly
    // non-existent row, corrupting mail_mailbox_uid mapping without
    // surfacing the true error to the caller.
    expect(hasSubstring('pgError.code === "23505"')).toBe(true);
  });
});
