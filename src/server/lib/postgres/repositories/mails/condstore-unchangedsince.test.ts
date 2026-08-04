/**
 * Repository-level guards for the RFC 7162 §3.1.3 UNCHANGEDSINCE ceiling —
 * inbox #610.
 *
 * `setMailFlags` gains an optional mod-sequence ceiling: the UPDATE only
 * touches rows at or below it, and everything the range matched but the guard
 * rejected comes back in `failed` for the caller to name in MODIFIED.
 *
 * STATIC SOURCE CHECKS, matching the `#671` and `#702 PR 2b-2` blocks in
 * imap.test.ts. A behavioural FakePool version of these cases was written
 * first and passes in isolation, but fails under a full `bun test src/server`:
 * `lib/imap/store.test.ts` calls `mock.module("../postgres/repositories/mails",
 * …)` with a stub `setMailFlags`, Bun's mock.module is process-global, and it
 * poisons the deep `./imap` specifier too — the imported binding comes back as
 * `[native code]` whichever path is used. No import reaches the real function
 * once that file has loaded.
 *
 * The behavioural proof for this feature is therefore the live-IMAP E2E against
 * a real Postgres (see the PR), which exercises the real guard against real
 * mod-sequences rather than a fake pool. These checks exist to catch the cheap
 * regression the E2E does not run on every commit: the guard being dropped from
 * one of the four query branches, or the failed set being computed off the
 * wrong side.
 */

import { describe, it, expect, beforeAll } from "bun:test";

let fnSource: string;

beforeAll(async () => {
  const fs = await import("fs/promises");
  const path = await import("path");
  const source = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
  const fnMatch = source.match(/export const setMailFlags[\s\S]*?\n};/);
  if (!fnMatch) throw new Error("setMailFlags not found in imap.ts");
  fnSource = fnMatch[0];
});

describe("setMailFlags — the UNCHANGEDSINCE guard", () => {
  it("takes unchangedSince as an optional parameter", () => {
    expect(fnSource).toMatch(/unchangedSince\?: number/);
  });

  it("branches on `!== undefined`, not on truthiness", () => {
    // `if (unchangedSince)` would silently route the RFC's UNCHANGEDSINCE 0
    // case — which must fail every message — into the unconditional path.
    expect(fnSource).toMatch(/const conditional = unchangedSince !== undefined/);
  });

  it("appends the guard to all four UPDATE branches, and to no SELECT", () => {
    const guardLines = fnSource
      .split("\n")
      .filter((line) => line.includes("conditional ?") && line.includes("MODSEQ"));
    expect(guardLines.length).toBe(4);
    guardLines.forEach((line) => expect(line).toContain("WHERE ${whereClause}"));
  });

  it("binds the ceiling one position past the reserved mod-sequence in each branch", () => {
    // Each branch stamps `MODSEQ = $N`, so the guard must read `$N+1` —
    // unchangedSince is appended after modseq in the values array. An
    // off-by-one here would compare the mod-sequence against a mailbox name.
    const branches: [RegExp, string][] = [
      [/MODSEQ\} = \$5[\s\S]{0,160}?MODSEQ\} <= \$6/, "domain + useUid"],
      [/MODSEQ\} = \$4[\s\S]{0,160}?MODSEQ\} <= \$5/, "domain + sequence"],
      [/MODSEQ\} = \$6[\s\S]{0,200}?MODSEQ\} <= \$7/, "mapped + useUid"],
      [/MODSEQ\} = \$5[\s\S]{0,200}?MODSEQ\} <= \$6/, "mapped + sequence"],
    ];
    branches.forEach(([re, label]) => {
      expect(`${label}=${re.test(fnSource)}`).toBe(`${label}=true`);
    });
  });

  it("appends unchangedSince after the reserved mod-sequence in the bound values", () => {
    expect(fnSource).toMatch(/\[\.\.\.baseValues, modseq, unchangedSince\]/);
  });

  it("computes the failed set as matched-minus-updated", () => {
    // The UPDATE can only report what it changed; the losers are knowable only
    // by diffing against the set the range matched.
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
    // counted as applied — and the no-op must still not reserve a mod-sequence.
    const noopBlock = fnSource.match(/if \(!setClause\) \{[\s\S]*?\n {4}\}/);
    expect(noopBlock).not.toBeNull();
    expect(noopBlock![0]).toContain("row.modseq > unchangedSince");
    expect(noopBlock![0]).not.toContain("getNextModseq");
  });

  it("returns the result object on the error path too, never a bare array", () => {
    expect(fnSource).toMatch(/return \{ updated: \[\], failed: \[\] \}/);
  });
});
