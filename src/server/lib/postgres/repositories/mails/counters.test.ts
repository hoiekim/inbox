/**
 * The counter-shape invariants that make `Starred` and `Trash` (#725) work
 * with real per-mailbox UIDs (option C). Two are load-bearing enough to pin
 * here on top of the DB-round-trip integration coverage the rest of the
 * suite gives them:
 *
 *  - `buildMailboxUidQuery` must NOT key its counter row on `sent`. The
 *    counter table's PK is `(user_id, uid_kind, uid_scope, sent)`, but a
 *    per-mailbox counter for a view that spans both sent axes has to
 *    enumerate ONE monotonic sequence — otherwise the 596 live sent mails
 *    on prod that hold a `uid_domain` value also held by a received mail
 *    would each get counter-side UID = 1 (the sent-scoped counter's first
 *    reservation), colliding with the received-side counter's UID = 1 on
 *    `mail_mailbox_uid_user_id_mailbox_uid_key`. `buildAccountUidQuery`
 *    can key on `sent` because `INBOX/accounts/<local>` and
 *    `Sent Messages/accounts/<local>` are two different mailboxes with
 *    disjoint UID spaces — Starred and Trash are one mailbox each.
 *
 *  - `syncMailboxPivot` has to insert-or-update on `saved=true` and delete
 *    on `saved=false`. That's the flag ⇔ pivot mirror the utility view
 *    reads through; a divergence is a mail visible in the flag surface
 *    (web / mails.saved) and invisible in the IMAP surface (Starred), or
 *    the reverse — depending on which side got the write.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

type Call = { sql: string; values: unknown[] };
let calls: Call[] = [];

/**
 * `next_uid` the fake counter row returns on the DO UPDATE branch — driving
 * `getMailboxUidNext` synchronously without a real Postgres reservation.
 */
let counterNextUid = 1;

const fakeQuery = async (sql: string, values?: unknown[]) => {
  calls.push({ sql, values: values ?? [] });
  const text = sql.trim().toUpperCase();

  // `getMailboxUidNext` → `reserveNextUid` → `buildMailboxUidQuery`'s INSERT
  // ... ON CONFLICT DO UPDATE ... RETURNING last_uid AS next_uid.
  if (text.includes("MAIL_UID_COUNTERS")) {
    return { rows: [{ next_uid: counterNextUid++ }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

const realClient = await import("../../client");
mock.module("../../client", () => ({ ...realClient, pool: { query: fakeQuery } }));

const counters = await import(`${import.meta.dir}/counters.ts?real=725-counters`);

afterAll(() => {
  mock.module("../../client", () => realClient);
});

beforeEach(() => {
  calls = [];
  counterNextUid = 1;
});

describe("buildMailboxUidQuery — 596-collision regression pin (#725)", () => {
  it("does not carry the `sent` column in its seed WHERE — one sequence per (user, mailbox)", () => {
    const { sql } = counters.buildMailboxUidQuery("user-1", "Starred");
    // The seed only fires on the first reservation, but its shape is what
    // permits one monotonic sequence spanning both `sent` axes. A stray
    // `sent = $N` in the seed would seed a per-`sent` MAX and let the two
    // halves collide on `mail_mailbox_uid_user_id_mailbox_uid_key`.
    const seedFragment = sql
      .split(/on conflict/i)[0]
      .toLowerCase();
    expect(seedFragment).toContain("mail_mailbox_uid");
    expect(seedFragment).not.toMatch(/\bsent\b\s*=\s*\$/);
  });

  it("keys the counter row on scope='<mailbox>', with `sent = FALSE` as a fixed placeholder — same values regardless of the reserving mail's sent axis", () => {
    // The composite key `(user_id, uid_kind, uid_scope, sent)` needs a value
    // for `sent`, so `buildMailboxUidQuery` hardcodes FALSE. What matters
    // is that it does NOT vary that value with the mail being reserved for
    // — otherwise a received-starred reservation and a sent-starred
    // reservation for the same mailbox would land on TWO counter rows and
    // both start emitting from 1, colliding on
    // `mail_mailbox_uid_user_id_mailbox_uid_key`. `buildAccountUidQuery`
    // legitimately keys on `sent` because its scopes ARE two different
    // mailboxes; this one is one.
    const first = counters.buildMailboxUidQuery("user-1", "Starred");
    const second = counters.buildMailboxUidQuery("user-1", "Starred");
    expect(first.values).toEqual(second.values);
    // The `sent` slot in the values list is always FALSE. `contains(false)`
    // alone would pass on a values list that happens to hold false for a
    // different reason, so also assert TRUE is absent — the query never
    // switches on sent for the same (user, mailbox).
    expect(first.values).toContain(false);
    expect(first.values).not.toContain(true);
  });
});

describe("syncMailboxPivot — mirrors the flag onto the pivot table (#725)", () => {
  it("reserves a mailbox UID and writes the pivot row on isPresent = true", async () => {
    await counters.syncMailboxPivot("user-1", "Starred", "mail-A", true);

    const sqls = calls.map((c) => c.sql.toLowerCase());
    // 1. `getMailboxUidNext` → INSERT INTO mail_uid_counters ...
    expect(sqls.some((s) => s.includes("mail_uid_counters"))).toBe(true);
    // 2. `writeMailboxUid` → INSERT INTO mail_mailbox_uid ... RETURNING uid
    const write = sqls.find(
      (s) => s.includes("insert into mail_mailbox_uid") && s.includes("returning")
    );
    expect(write).toBeDefined();
    // No DELETE issued.
    expect(sqls.some((s) => s.includes("delete from mail_mailbox_uid"))).toBe(false);
  });

  it("deletes the pivot row on isPresent = false — and does not reserve a counter tick", async () => {
    await counters.syncMailboxPivot("user-1", "Starred", "mail-A", false);

    const sqls = calls.map((c) => c.sql.toLowerCase());
    // 1. DELETE FROM mail_mailbox_uid ... WHERE ... AND mail_id = $3.
    expect(sqls.some((s) => s.includes("delete from mail_mailbox_uid"))).toBe(true);
    // The delete branch is idempotent — no reservation, so re-clearing an
    // already-cleared flag doesn't advance the counter and can't push a
    // later re-star past MAX(uid) unnecessarily. Advancing on the FALSE
    // branch would still be correct (fresh UIDs on re-star are what the RFC
    // requires) but wasteful; pin the intent.
    expect(sqls.some((s) => s.includes("mail_uid_counters"))).toBe(false);
    // No pivot INSERT.
    expect(sqls.some((s) => s.includes("insert into mail_mailbox_uid"))).toBe(false);
  });

  it("targets the pivot delete on (user, mailbox, mail_id) — not by uid", async () => {
    // The pivot's PK is (user_id, mailbox, mail_id); the (user_id, mailbox,
    // uid) unique index is a SECOND uniqueness rule. A delete keyed on uid
    // would still work today, but the caller doesn't know the UID and
    // shouldn't have to — an unstar targets a MESSAGE, not a UID that the
    // read side happens to have handed out.
    await counters.syncMailboxPivot("user-1", "Starred", "mail-B", false);
    const del = calls.find((c) =>
      c.sql.toLowerCase().includes("delete from mail_mailbox_uid")
    );
    expect(del).toBeDefined();
    // (user_id, mailbox, mail_id) — three params, in that order.
    expect(del!.values).toEqual(["user-1", "Starred", "mail-B"]);
    expect(del!.sql.toLowerCase()).not.toContain(" uid ");
  });
});
