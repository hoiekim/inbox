/**
 * The counter-shape invariants that make `Starred` and `Trash` (#725) work
 * with real per-mailbox UIDs (option C).
 *
 * `buildMailboxUidQuery` must NOT key its counter row on `sent`. The
 * counter table's PK is `(user_id, uid_kind, uid_scope, sent)`, but a
 * per-mailbox counter for a view that spans both sent axes has to
 * enumerate ONE monotonic sequence — otherwise the 596 live sent mails
 * on prod that hold a `uid_domain` value also held by a received mail
 * would each get counter-side UID = 1 (the sent-scoped counter's first
 * reservation), colliding with the received-side counter's UID = 1 on
 * `mail_mailbox_uid_user_id_mailbox_uid_key`. `buildAccountUidQuery`
 * can key on `sent` because `INBOX/accounts/<local>` and
 * `Sent Messages/accounts/<local>` are two different mailboxes with
 * disjoint UID spaces — Starred and Trash are one mailbox each.
 *
 * Pure query-shape checks only — no pool mock. `syncMailboxPivot`'s
 * behavior is pinned at the integration layer in
 * `src/server/lib/imap/message-ops.test.ts` ("storeFlagsTyped — Starred /
 * Trash pivot sync (#725)"), which exercises the pool through the whole
 * STORE handler. Splitting the two layers keeps this file's mock surface
 * empty, which matters here: Bun's `mock.module` is process-global (see
 * `reference_bun_mock_module_global_hoisting.md`), and a leaked mock of
 * `../../client` from this file has surfaced on Linux CI as unrelated
 * `users.test.ts` failures (mock ordering differs Linux vs macOS by
 * filesystem enumeration order).
 */
import { describe, it, expect } from "bun:test";
import { buildMailboxUidQuery } from "./counters";

describe("buildMailboxUidQuery — 596-collision regression pin (#725)", () => {
  it("does not carry the `sent` column in its seed WHERE — one sequence per (user, mailbox)", () => {
    const { sql } = buildMailboxUidQuery("user-1", "Starred");
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
    const first = buildMailboxUidQuery("user-1", "Starred");
    const second = buildMailboxUidQuery("user-1", "Starred");
    expect(first.values).toEqual(second.values);
    // The `sent` slot in the values list is always FALSE. `contains(false)`
    // alone would pass on a values list that happens to hold false for a
    // different reason, so also assert TRUE is absent — the query never
    // switches on sent for the same (user, mailbox).
    expect(first.values).toContain(false);
    expect(first.values).not.toContain(true);
  });

  it("scopes the counter row by the mailbox name — Starred and Trash are separate sequences", () => {
    const starred = buildMailboxUidQuery("user-1", "Starred");
    const trash = buildMailboxUidQuery("user-1", "Trash");
    // The mailbox name appears in the values list (as uid_scope AND the seed
    // WHERE MAILBOX = $5). If Starred and Trash shared a counter row, uids
    // would interleave across the two boxes — a mail starred at Starred uid
    // 5 could then take Trash uid 6 for a completely unrelated deletion.
    expect(starred.values).toContain("Starred");
    expect(trash.values).toContain("Trash");
    expect(starred.values).not.toContain("Trash");
    expect(trash.values).not.toContain("Starred");
  });
});
