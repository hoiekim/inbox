/**
 * Repository-level guards for the RFC 7162 §3.1.3 UNCHANGEDSINCE ceiling —
 * inbox #610.
 *
 * `setMailFlags` gains an optional mod-sequence ceiling: the UPDATE only
 * touches rows at or below it, and everything the range matched but the guard
 * rejected comes back in `failed` for the caller to name in MODIFIED.
 *
 * ## Why these are static source checks
 *
 * Two separate process-global mocks block a behavioural test here, and both
 * were measured rather than assumed:
 *
 * 1. `lib/imap/store.test.ts` calls
 *    `mock.module("../postgres/repositories/mails", …)` with a stub
 *    `setMailFlags`. That poisons the deep `./imap` specifier too — under a
 *    full `bun test src/server`, `import("./imap")` yields a 29-char
 *    `[native code]` stub. A cache-busting suffix
 *    (`import(`${import.meta.dir}/imap.ts?real=610`)`) IS a distinct registry
 *    key and does return the real 4120-char function, so this one is solvable.
 * 2. But the real function's `pool` comes from `postgres/client.ts`, which is
 *    itself replaced by another file's global mock — probed under the full
 *    suite, `pool.constructor.name` is `Object` and a locally-installed
 *    `pg` FakePool is never called (0 invocations), even re-installing it with
 *    `mock.module` + `resetPool()` in `beforeEach`. The real code runs against
 *    someone else's pool and returns an empty result.
 *
 * Getting behavioural coverage would mean adding a third process-global
 * `mock.module` of `postgres/client` — the pattern #557 already proposes
 * retiring, and one that would leak into every file loaded after this one.
 * Not worth it for this PR.
 *
 * The behavioural proof is therefore the live-IMAP E2E against a real Postgres
 * (see the PR), which exercises the real guard against real mod-sequences.
 * These checks catch the cheap regression the E2E does not run on every commit:
 * the guard being dropped from one of the four query branches, or an
 * off-by-one in its bound-parameter index. Each is anchored to a specific
 * branch — see the block-splitting below — so no two assertions are
 * interchangeable.
 */

import { describe, it, expect, beforeAll } from "bun:test";

let fnSource: string;
/** The four `updateSql = \`…\`` assignments, in source order. */
let updateBlocks: string[];

const BRANCHES = [
  { label: "domain-scoped, UID range", stamped: 5, guard: 6, alias: false },
  { label: "domain-scoped, sequence", stamped: 4, guard: 5, alias: false },
  { label: "mapped mailbox, UID range", stamped: 6, guard: 7, alias: true },
  { label: "mapped mailbox, sequence", stamped: 5, guard: 6, alias: true },
];

beforeAll(async () => {
  const fs = await import("fs/promises");
  const path = await import("path");
  const source = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
  const fnMatch = source.match(/export const setMailFlags[\s\S]*?\n};/);
  if (!fnMatch) throw new Error("setMailFlags not found in imap.ts");
  fnSource = fnMatch[0];

  // Split on the assignment so each branch is asserted in isolation. Two
  // branches share the same $5/$6 pair, so a whole-function regex cannot tell
  // them apart — matching one would satisfy an assertion aimed at the other.
  // Cut at RETURNING, not at the next backtick: the guard itself is a nested
  // template literal, so a backtick split would truncate the block right
  // before the thing under test.
  updateBlocks = fnSource
    .split("updateSql = `")
    .slice(1)
    .map((chunk) => chunk.split("RETURNING")[0]);
});

describe("setMailFlags — the UNCHANGEDSINCE guard", () => {
  it("takes unchangedSince as an optional parameter", () => {
    expect(fnSource).toMatch(/unchangedSince\?: number/);
  });

  it("branches on `!== undefined`, not on truthiness", () => {
    // `if (unchangedSince)` would route the RFC's UNCHANGEDSINCE 0 case —
    // which must fail every message — into the unconditional path and apply
    // the store.
    expect(fnSource).toMatch(/const conditional = unchangedSince !== undefined/);
  });

  it("finds exactly the four expected UPDATE branches", () => {
    expect(updateBlocks.length).toBe(BRANCHES.length);
  });

  it.each(BRANCHES.map((b, i) => [b.label, i] as const))(
    "%s guards on the index one past its stamped mod-sequence",
    (_label, i) => {
      const block = updateBlocks[i];
      const { stamped, guard, alias } = BRANCHES[i];
      const col = alias ? "m\\.\\$\\{MODSEQ\\}" : "\\$\\{MODSEQ\\}";
      // Stamps the freshly reserved mod-sequence at $stamped …
      expect(block).toMatch(new RegExp(`\\$\\{MODSEQ\\} = \\$${stamped}\\b`));
      // … and reads the client's ceiling from $guard, one position later,
      // because unchangedSince is appended after modseq in the values array.
      // An off-by-one here compares a mod-sequence against a mailbox name or
      // an out-of-range parameter.
      expect(block).toMatch(new RegExp(`conditional \\? \` AND ${col} <= \\$${guard}\``));
    }
  );

  it("puts the guard on no SELECT — only the UPDATE is conditional", () => {
    const selectBlocks = fnSource
      .split("selectSql = `")
      .slice(1)
      .map((chunk) => chunk.split("`;")[0]);
    expect(selectBlocks.length).toBe(BRANCHES.length);
    selectBlocks.forEach((block) => expect(block).not.toContain("conditional ?"));
  });

  it("appends unchangedSince after the reserved mod-sequence in the bound values", () => {
    expect(fnSource).toMatch(/\[\.\.\.baseValues, modseq, unchangedSince\]/);
  });

  it("computes the failed set as matched-minus-updated", () => {
    // The UPDATE can only report the rows it changed; the losers are knowable
    // only by diffing against the set the range matched.
    expect(fnSource).toContain("const updatedUids = new Set(updated.map((row) => row.uid))");
    expect(fnSource).toMatch(
      /matched\.rows[\s\S]{0,160}filter\(\(uid\) => !updatedUids\.has\(uid\)\)/
    );
  });

  it("pays for the extra matched-set SELECT only on the conditional path", () => {
    const unconditional = fnSource.match(/if \(!conditional\) \{[\s\S]*?\n {4}\}/);
    expect(unconditional).not.toBeNull();
    expect(unconditional![0]).toContain("updateSql");
    expect(unconditional![0]).not.toContain("selectSql");
  });

  it("still answers the ceiling question on the no-op (empty setClause) path", () => {
    // RFC 3501 §6.4.6 makes `+FLAGS ()` a legal no-op, but a row the client
    // believes is older than it is must still land in MODIFIED rather than be
    // counted as applied — and a no-op must still not reserve a mod-sequence.
    const noopBlock = fnSource.match(/if \(!setClause\) \{[\s\S]*?\n {4}\}/);
    expect(noopBlock).not.toBeNull();
    expect(noopBlock![0]).toContain("row.modseq > unchangedSince");
    expect(noopBlock![0]).not.toContain("getNextModseq");
  });

  it("returns the result object on the error path too, never a bare array", () => {
    expect(fnSource).toMatch(/return \{ updated: \[\], failed: \[\] \}/);
  });
});
