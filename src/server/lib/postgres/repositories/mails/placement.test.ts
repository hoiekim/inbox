import { describe, it, expect } from "bun:test";

// Anchor on `import.meta.url` rather than `process.cwd()` — the former is
// invocation-directory independent (matches the sibling pattern in
// `postgres/models/models.test.ts`), so the file loads correctly whether
// bun test runs from repo root, a subdir, or the Docker WORKDIR.
//
// Read via `Bun.file(...).text()` NOT `fs.readFileSync`: two sibling test
// files (`mailgun.test.ts`, `http/routes/health.test.ts`) do
// `mock.module("fs", ...)`, which is process-global in Bun and, under some
// full-suite file orderings, replaces `readFileSync` with an undefined
// export on this file's `import { readFileSync } from "fs"`. `Bun.file` is
// on the global `Bun.*` namespace, not the `fs` module surface — immune to
// the leak.
const CORE_TS_URL = new URL("./core.ts", import.meta.url);
const CORE_TS = await Bun.file(CORE_TS_URL).text();

/**
 * Extract the substring of core.ts BETWEEN two literal anchor snippets —
 * inclusive of the start anchor, up to (but not including) the end anchor.
 * Throws if either anchor is missing or the end anchor precedes the start,
 * so a refactor that removes an anchor fails loudly here (rather than
 * silently narrowing every subsequent per-branch assertion to an empty
 * string that passes every `.includes` check).
 */
const sliceBetween = (start: string, end: string): string => {
  const s = CORE_TS.indexOf(start);
  if (s === -1) throw new Error(`slice anchor missing: "${start}"`);
  const e = CORE_TS.indexOf(end, s + start.length);
  if (e === -1) throw new Error(`slice end anchor missing: "${end}" after "${start}"`);
  return CORE_TS.slice(s, e);
};

// Per-branch source slices. The anchors are chosen for stability under
// legitimate refactor: the `const data:` opening and the `mailsTable.insert`
// call are the natural start/end of the INSERT branch's data composition;
// the `if (pgError.code === "23505")` guard and the closing `throw error;`
// bracket the merge branch's body.
const INSERT_BRANCH_SLICE = sliceBetween(
  "const data:",
  "const row = await mailsTable.insert("
);
const MERGE_BRANCH_SLICE = sliceBetween(
  'pgError.code === "23505"',
  "throw error;"
);

describe("saveMail — utility placement on the INSERT branch", () => {
  it("spreads `input.placement` into the INSERT `data` object", () => {
    // Pinned within the INSERT-branch slice specifically — a regression
    // that drops the spread from THIS branch while leaving the merge
    // branch's spread intact would still fail this pin.
    expect(INSERT_BRANCH_SLICE.includes("...input.placement")).toBe(true);
  });

  it("calls `mailsTable.insert(data, [MAIL_ID])` immediately after composing `data`", () => {
    // The slice's END anchor asserts the INSERT call exists. If someone
    // removed the INSERT (e.g. early-return before the call), the slice
    // extraction itself throws — a louder failure than a boolean assertion.
    // Confirm the call is well-formed by looking at core.ts directly.
    expect(CORE_TS.includes("mailsTable.insert(data, [MAIL_ID])")).toBe(true);
  });
});

describe("saveMail — utility placement on the 23505 merge branch", () => {
  it("guards the merge-branch UPDATE on `input.placement` being present", () => {
    // The 23505 branch fires for cross-delivery re-sends of the same
    // Message-ID from distinct SMTP sessions. Without a placement, the
    // merge branch must not issue a spurious membership-flip UPDATE (that
    // would advance the mod-sequence for a no-op, breaking HIGHESTMODSEQ
    // reads by CONDSTORE clients).
    expect(MERGE_BRANCH_SLICE.includes("if (input.placement)")).toBe(true);
  });

  it("issues `mailsTable.updateWhere(...)` with the placement spread + modseq bump", () => {
    // All three shape signals must sit inside the merge branch slice —
    // whole-file matches would let a regression that dropped the merge
    // branch's spread pass because INSERT still has the spread.
    expect(MERGE_BRANCH_SLICE.includes("mailsTable.updateWhere(")).toBe(true);
    expect(MERGE_BRANCH_SLICE.includes("...input.placement")).toBe(true);
    expect(
      MERGE_BRANCH_SLICE.includes("[MODSEQ]: await getNextModseq(input.user_id)")
    ).toBe(true);
  });

  it("re-reads the existing row via `getMailByMessageId` after 23505", () => {
    // The merge branch needs the pre-existing mail_id (returned to the
    // caller as `_id` so a COPY/APPEND partial-failure retry converges on
    // the first-attempt row). A regression that dropped the re-read would
    // return `undefined` and turn the successful merge into a NACK — the
    // sender or client retries in a loop.
    expect(
      MERGE_BRANCH_SLICE.includes(
        "getMailByMessageId(input.user_id, input.message_id)"
      )
    ).toBe(true);
  });
});

describe("saveMail — 23505 code narrows the merge branch", () => {
  it("only takes the merge path on `pgError.code === \"23505\"`", () => {
    // A regression that widened the catch to any error would silently
    // swallow every save failure as a merge attempt against a possibly
    // non-existent row, corrupting mail_mailbox_uid mapping without
    // surfacing the true error to the caller. Whole-file check is fine here
    // — the 23505 literal is unique to this guard.
    expect(CORE_TS.includes('pgError.code === "23505"')).toBe(true);
  });
});
