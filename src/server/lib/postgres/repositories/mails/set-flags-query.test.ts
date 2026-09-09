/**
 * Shape guards for `buildSetMailFlagsQueries`, asserted on the SQL it returns.
 *
 * The queries are built and read directly — no pool, per the convention
 * `mail-modseq.test.ts` states: *"Pure `build*` helpers pin the SQL shape with
 * no pool interception."* Reading the emitted string rather than the builder's
 * source text is what makes these guards mean what they say. A source-level
 * scan can only recognise the spelling of a property it was taught: it reads a
 * conditional filter written with `&&` as unconditional, and it reads `??` or
 * a JSONB existence operator in an unchanged query as a conditional. The
 * emitted SQL has no spelling — a filter is present or it is not.
 *
 * The mailboxes below are chosen so the branches disagree. `Archive` filters
 * nothing, so its membership rule renders `TRUE` and its `AND`-suffix form
 * renders empty; that is the box where a filter accidentally gated on
 * membership disappears, and the only box that can prove one is not.
 */

import { describe, it, expect } from "bun:test";
import { buildSetMailFlagsQueries } from "./set-flags-query";

const USER = "user-1";
const START = 3;
const END = 9;
const SET_CLAUSE = "read = TRUE";

const build = (
  mailbox: string | null,
  sent: boolean,
  useUid: boolean,
  conditional = false
) =>
  buildSetMailFlagsQueries(
    USER,
    mailbox,
    sent,
    START,
    END,
    useUid,
    SET_CLAUSE,
    conditional
  );

interface Branch {
  label: string;
  mailbox: string | null;
  sent: boolean;
  useUid: boolean;
  /** The alias `expunged` wears where this branch applies it. */
  expunged: string;
  /** Membership terms the box contributes; empty for a box that shows everything. */
  membership: string[];
  baseValues: (string | number | boolean)[];
}

const BRANCHES: Branch[] = [
  {
    label: "domain UID range, INBOX tree",
    mailbox: null,
    sent: false,
    useUid: true,
    expunged: "expunged",
    membership: ["is_spam = FALSE", "draft = FALSE"],
    baseValues: [USER, false, START, END],
  },
  {
    label: "domain sequence, INBOX tree",
    mailbox: null,
    sent: false,
    useUid: false,
    expunged: "expunged",
    membership: ["is_spam = FALSE", "draft = FALSE"],
    baseValues: [USER, false, START - 1, END - START + 1],
  },
  {
    label: "domain UID range, sent lane (filters nothing)",
    mailbox: null,
    sent: true,
    useUid: true,
    expunged: "expunged",
    membership: [],
    baseValues: [USER, true, START, END],
  },
  {
    label: "domain sequence, sent lane (filters nothing)",
    mailbox: null,
    sent: true,
    useUid: false,
    expunged: "expunged",
    membership: [],
    baseValues: [USER, true, START - 1, END - START + 1],
  },
  {
    label: "utility view stays in the domain UID space",
    mailbox: "Junk",
    sent: false,
    useUid: true,
    expunged: "expunged",
    membership: ["is_spam = TRUE"],
    baseValues: [USER, false, START, END],
  },
  {
    label: "mapped UID range, INBOX tree",
    mailbox: "INBOX/accounts/someone",
    sent: false,
    useUid: true,
    expunged: "m.expunged",
    membership: ["m.is_spam = FALSE", "m.draft = FALSE"],
    baseValues: [USER, false, "INBOX/accounts/someone", START, END],
  },
  {
    label: "mapped UID range, box that filters nothing",
    mailbox: "Archive",
    sent: false,
    useUid: true,
    expunged: "m.expunged",
    membership: [],
    baseValues: [USER, false, "Archive", START, END],
  },
  {
    label: "mapped sequence, INBOX tree",
    mailbox: "INBOX/accounts/someone",
    sent: false,
    useUid: false,
    expunged: "z.expunged",
    membership: ["z.is_spam = FALSE", "z.draft = FALSE"],
    baseValues: [USER, false, "INBOX/accounts/someone", START - 1, END - START + 1],
  },
  {
    label: "mapped sequence, box that filters nothing",
    mailbox: "Archive",
    sent: false,
    useUid: false,
    expunged: "z.expunged",
    membership: [],
    baseValues: [USER, false, "Archive", START - 1, END - START + 1],
  },
];

const rows = BRANCHES.map((branch) => [branch.label, branch] as const);
const seqRows = rows.filter(([, branch]) => !branch.useUid);
const uidRows = rows.filter(([, branch]) => branch.useUid);

/** Every distinct `$N` the statement binds, ascending. */
const paramIndices = (sql: string): number[] =>
  [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort(
    (a, b) => a - b
  );

const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/** Everything from the `FROM` onwards — the match, without the projection. */
const matchOf = (sql: string): string => sql.slice(sql.indexOf(" FROM "));

describe("buildSetMailFlagsQueries — the emitted match", () => {
  it.each(rows)("%s never addresses expunged mail", (_label, branch) => {
    const { selectSql, matchedUidSql, updateSql } = build(
      branch.mailbox,
      branch.sent,
      branch.useUid
    );
    // A STORE that reaches an expunged mail bumps a mod-sequence no client can
    // resolve, and on a sequence branch it shifts every position after the
    // expunged row — so the EXPUNGE behind a `\Deleted` store destroys the
    // wrong message.
    for (const sql of [selectSql, matchedUidSql, updateSql]) {
      expect(sql).toContain(`${branch.expunged} = FALSE`);
    }
  });

  it("keeps the sequence walk's own filters on a box whose membership rule is TRUE", () => {
    // The walk slices the same UID-ordered list `getAllUids` builds, so it has
    // to carry `sent` and `expunged` itself — mapping rows outlive the expunge
    // that hid their mail. Those filters must not ride on the membership rule:
    // it renders `TRUE` here, so anything gated on it vanishes for precisely
    // the boxes that still need the filters.
    const { selectSql } = build("Archive", false, false);
    expect(selectSql).toContain("z.sent = $2");
    expect(selectSql).toContain("z.expunged = FALSE");
    expect(selectSql).toContain("AND TRUE");
  });

  it.each(rows)("%s applies exactly its own membership rule", (_label, branch) => {
    const { selectSql, matchedUidSql, updateSql } = build(
      branch.mailbox,
      branch.sent,
      branch.useUid
    );
    for (const sql of [selectSql, matchedUidSql, updateSql]) {
      for (const term of branch.membership) expect(sql).toContain(term);
      // A box that shows everything must not inherit another view's rule.
      if (branch.membership.length === 0) expect(sql).not.toContain("is_spam");
    }
  });

  it.each(rows)("%s projects the UID-only match over the same rows", (_label, branch) => {
    // The conditional path diffs matched UIDs against updated ones to name the
    // MODIFIED set, so a match that drifts from the SELECT's reports the wrong
    // messages as failed.
    const { selectSql, matchedUidSql } = build(branch.mailbox, branch.sent, branch.useUid);
    expect(matchOf(matchedUidSql)).toBe(matchOf(selectSql));
    expect(matchedUidSql.slice(0, matchedUidSql.indexOf(" FROM "))).not.toContain("read");
  });
});

describe("buildSetMailFlagsQueries — the emitted range", () => {
  it.each(seqRows)("%s slices the 1-based range as OFFSET/LIMIT", (_label, branch) => {
    const { selectSql, updateSql, baseValues } = build(
      branch.mailbox,
      branch.sent,
      branch.useUid
    );
    // IMAP sequence numbers are 1-based while OFFSET counts from 0, and a
    // `STORE 2:5` has to reach four messages. Both indices are read back off
    // the values array the same call returns, so the emitted numbering and the
    // bound values cannot drift apart.
    const offset = baseValues.length - 1;
    const limit = baseValues.length;
    for (const sql of [selectSql, updateSql]) {
      expect(sql).toContain(`OFFSET $${offset} LIMIT $${limit}`);
    }
    expect(baseValues[offset - 1]).toBe(START - 1);
    expect(baseValues[limit - 1]).toBe(END - START + 1);
  });

  it.each(uidRows)("%s bounds the UID range instead of paging it", (_label, branch) => {
    const { selectSql, updateSql } = build(branch.mailbox, branch.sent, branch.useUid);
    for (const sql of [selectSql, updateSql]) {
      expect(sql).not.toContain("OFFSET");
      expect(sql).not.toContain("LIMIT");
    }
  });

  it.each(rows)("%s binds the values its placeholders name", (_label, branch) => {
    expect(build(branch.mailbox, branch.sent, branch.useUid).baseValues).toEqual(
      branch.baseValues
    );
  });
});

describe("buildSetMailFlagsQueries — placeholder numbering", () => {
  it.each(rows)("%s numbers the match contiguously from $1", (_label, branch) => {
    const { selectSql, matchedUidSql, baseValues } = build(
      branch.mailbox,
      branch.sent,
      branch.useUid
    );
    // The caller binds `baseValues` to the match verbatim, so a gap or an
    // overrun here is a bound value read into the wrong column.
    for (const sql of [selectSql, matchedUidSql]) {
      expect(paramIndices(sql)).toEqual(upTo(baseValues.length));
    }
  });

  it.each(rows)("%s appends the stamped mod-sequence past the bound values", (_label, branch) => {
    const { updateSql, baseValues } = build(branch.mailbox, branch.sent, branch.useUid);
    // The caller appends `modseq` to `baseValues`, so its index is that array's
    // length plus one — not a number chosen in the template.
    expect(paramIndices(updateSql)).toEqual(upTo(baseValues.length + 1));
    expect(updateSql).toContain(`modseq = $${baseValues.length + 1}`);
  });

  it.each(rows)("%s guards on one index past the stamped mod-sequence", (_label, branch) => {
    const { selectSql, updateSql, baseValues } = build(
      branch.mailbox,
      branch.sent,
      branch.useUid,
      true
    );
    // With UNCHANGEDSINCE the caller binds [...baseValues, modseq, ceiling].
    expect(paramIndices(updateSql)).toEqual(upTo(baseValues.length + 2));
    expect(updateSql).toContain(`modseq <= $${baseValues.length + 2}`);
    // Only the UPDATE is conditional — the match still reports what the range
    // covered, which is what names the MODIFIED set.
    expect(selectSql).not.toContain("modseq <=");
  });
});
