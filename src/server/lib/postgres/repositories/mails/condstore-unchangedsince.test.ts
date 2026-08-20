/**
 * Repository-level guards for the RFC 7162 §3.1.3 UNCHANGEDSINCE ceiling.
 *
 * `setMailFlags` gains an optional mod-sequence ceiling: the UPDATE only
 * touches rows at or below it, and everything the range matched but the guard
 * rejected comes back in `failed` for the caller to name in MODIFIED.
 *
 * These drive `buildSetMailFlagsQueries` — the pure half of `setMailFlags` —
 * per the convention `mail-modseq.test.ts` states: *"Pure `build*` helpers pin
 * the SQL shape with no pool interception."* That matters here beyond style.
 * A behavioural test of `setMailFlags` itself is blocked by two process-global
 * mocks (`lib/imap/store.test.ts` replaces the `repositories/mails` barrel,
 * which poisons the deep `./imap` specifier; `postgres/client.ts` is replaced
 * by another file's mock, so the real function runs against someone else's
 * pool). This module is imported by neither, so the queries can simply be
 * built and read.
 *
 * The behavioural proof of the guard against real mod-sequences is the
 * live-IMAP E2E in the PR. These pin the cheap regression the E2E does not run
 * on every commit: the guard dropped from a branch, or its bound-parameter
 * index drifting away from the values array.
 */

import { describe, it, expect } from "bun:test";
import { buildSetMailFlagsQueries } from "./set-flags-query";

const build = (opts: { mailbox: string | null; useUid: boolean; conditional?: boolean }) =>
  buildSetMailFlagsQueries(
    "user-1",
    opts.mailbox,
    false,
    3,
    9,
    opts.useUid,
    "read = TRUE",
    opts.conditional ?? true
  );

/**
 * `usesDomainUidSpace(null)` is the domain-scoped space; a named mailbox goes
 * through the `mail_mailbox_uid` join. Only the two `useUid: true` rows are
 * reachable in production — `setMailFlags` has one call site, which passes a
 * literal `true` — but all four are built, so all four are pinned.
 */
const BRANCHES = [
  { label: "domain-scoped, UID range", mailbox: null, useUid: true, alias: "" },
  { label: "domain-scoped, sequence", mailbox: null, useUid: false, alias: "" },
  { label: "mapped mailbox, UID range", mailbox: "Work", useUid: true, alias: "m." },
  { label: "mapped mailbox, sequence", mailbox: "Work", useUid: false, alias: "m." },
] as const;

describe("buildSetMailFlagsQueries — the UNCHANGEDSINCE guard", () => {
  it.each(BRANCHES.map((b) => [b.label, b] as const))(
    "%s guards on the index one past its stamped mod-sequence",
    (_label, branch) => {
      const { updateSql, baseValues } = build(branch);
      // The caller binds [...baseValues, modseq, unchangedSince], so these two
      // indices are not free choices — they are determined by the values array
      // this same call returns. Reading both from `baseValues` is the whole
      // point of building the query instead of scanning its source text.
      const stamped = baseValues.length + 1;
      const guard = stamped + 1;
      // The SET assigns the target table's own column, so it carries no
      // alias; the guard sits in the WHERE, where the mapped branches do.
      expect(updateSql).toContain(`CURRENT_TIMESTAMP, modseq = $${stamped}`);
      expect(updateSql).toContain(`AND ${branch.alias}modseq <= $${guard}`);
    }
  );

  it.each(BRANCHES.map((b) => [b.label, b] as const))(
    "%s puts the guard on no SELECT — only the UPDATE is conditional",
    (_label, branch) => {
      const { selectSql } = build(branch);
      expect(selectSql).not.toContain("modseq <=");
    }
  );

  it.each(BRANCHES.map((b) => [b.label, b] as const))(
    "%s omits the guard entirely when the STORE is unconditional",
    (_label, branch) => {
      const { updateSql, baseValues } = build({ ...branch, conditional: false });
      expect(updateSql).toContain(`CURRENT_TIMESTAMP, modseq = $${baseValues.length + 1}`);
      expect(updateSql).not.toContain("modseq <=");
    }
  );

  it("never reuses a placeholder the base values already occupy", () => {
    BRANCHES.forEach((branch) => {
      const { updateSql, baseValues } = build(branch);
      // A guard index at or below baseValues.length would silently compare the
      // mod-sequence against a mailbox name or a range bound.
      const guard = Number(updateSql.match(/modseq <= \$(\d+)/)![1]);
      expect(guard).toBeGreaterThan(baseValues.length + 1);
    });
  });

  it("orders the base values so each placeholder names what the SQL expects", () => {
    expect(build({ mailbox: null, useUid: true }).baseValues).toEqual([
      "user-1",
      false,
      3,
      9,
    ]);
    expect(build({ mailbox: "Work", useUid: true }).baseValues).toEqual([
      "user-1",
      false,
      "Work",
      3,
      9,
    ]);
  });

  it.each(BRANCHES.map((b) => [b.label, b] as const))(
    "%s reads the matched set as UIDs alone, not eight flag columns per row",
    (_label, branch) => {
      // The conditional path reads it only to diff matched against updated.
      const { selectSql, matchedUidSql } = build(branch);
      expect(matchedUidSql).toMatch(/^SELECT \S+ as uid FROM /);
      expect(matchedUidSql).not.toContain("saved");
      expect(matchedUidSql).not.toContain("answered");
      // Same match, narrower projection — the WHERE has to be identical or the
      // difference stops being matched-minus-updated.
      const whereOf = (sql: string) => sql.slice(sql.indexOf(" FROM "));
      expect(whereOf(matchedUidSql)).toBe(whereOf(selectSql));
    }
  );

  it("scopes the STORE to the messages the mailbox shows, not the whole table", () => {
    // Without this the STORE would address quarantined spam the client was
    // never shown, and a following EXPUNGE would destroy it.
    const { selectSql } = build({ mailbox: null, useUid: true });
    expect(selectSql).toContain("is_spam");
  });
});
