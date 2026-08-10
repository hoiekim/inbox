
import { describe, it, expect } from "bun:test";
import {
  buildDomainUidQuery,
  buildAccountUidQuery,
  buildDomainUidNextQuery,
  buildAccountUidNextQuery,
} from "./mails";
import { mailUidCountersTable } from "../models";
import { USER_ID, UID_KIND, UID_SCOPE, SENT, LAST_UID } from "../models";

const userId = "11111111-1111-1111-1111-111111111111";

describe("mail_uid_counters table", () => {
  it("declares the composite PRIMARY KEY the reservation upsert conflicts on", () => {
    expect(mailUidCountersTable.constraints).toContain(
      `PRIMARY KEY (${USER_ID}, ${UID_KIND}, ${UID_SCOPE}, ${SENT})`
    );
  });
});

describe("buildDomainUidQuery", () => {
  it("reserves atomically via INSERT … ON CONFLICT DO UPDATE on mail_uid_counters", () => {
    const { sql, values } = buildDomainUidQuery(userId, false);
    expect(sql).toContain("INSERT INTO mail_uid_counters");
    expect(sql).toContain(
      `ON CONFLICT (${USER_ID}, ${UID_KIND}, ${UID_SCOPE}, ${SENT})`
    );
    expect(sql).toContain(
      `DO UPDATE SET ${LAST_UID} = mail_uid_counters.${LAST_UID} + 1`
    );
    expect(sql).toContain(`RETURNING ${LAST_UID} AS next_uid`);
    // Seeds once from the live MAX so existing mailboxes stay continuous.
    expect(sql).toContain("COALESCE(MAX(uid_domain), 0) + 1");
    // kind = "domain", scope = "" — never collides with an account row.
    expect(values).toEqual([userId, "domain", "", false]);
  });

  it("does NOT issue the racy bare MAX(uid)+1 read", () => {
    const { sql } = buildDomainUidQuery(userId, false);
    expect(sql).not.toContain("AS next_uid FROM mails");
  });

  it("passes sent=true through to the counter sequence", () => {
    const { values } = buildDomainUidQuery(userId, true);
    expect(values).toEqual([userId, "domain", "", true]);
  });
});

describe("buildAccountUidQuery", () => {
  it("reserves atomically, keyed by kind=account + the address scope", () => {
    const { sql, values } = buildAccountUidQuery(userId, "user@hoie.kim", false);
    expect(sql).toContain("INSERT INTO mail_uid_counters");
    expect(sql).toContain(
      `DO UPDATE SET ${LAST_UID} = mail_uid_counters.${LAST_UID} + 1`
    );
    expect(sql).toContain("COALESCE(MAX(uid), 0) + 1 FROM mail_mailbox_uid");
    expect(values[1]).toBe("account");
    expect(values[2]).toBe("user@hoie.kim");
    expect(values[3]).toBe(false);
  });

  it("seeds the received sequence from the account-scoped INBOX path + the raw local part", () => {
    // Per-account received: `INBOX/accounts/<local>`. Fallback path
    // (`<local>` alone) covers user-created mailboxes where the write
    // side stores the raw box name (e.g. `Archive`) — the OR-union
    // catches both under one indexed lookup.
    const { sql, values } = buildAccountUidQuery(userId, "user@hoie.kim", false);
    expect(sql).toContain("mailbox IN ($5, $6)");
    expect(values[4]).toBe("INBOX/accounts/user");
    expect(values[5]).toBe("user");
  });

  it("seeds the sent sequence from the Sent-account path + the raw local part", () => {
    const { sql, values } = buildAccountUidQuery(userId, "user@hoie.kim", true);
    expect(sql).toContain("mailbox IN ($5, $6)");
    expect(values[4]).toBe("Sent Messages/accounts/user");
    expect(values[5]).toBe("user");
    expect(values[3]).toBe(true);
    expect(sql).not.toContain("to_address @>");
    expect(sql).not.toContain("from_address @>");
  });
});

/**
 * UIDNEXT peek (#743).
 *
 * UIDNEXT must exceed every UID ever assigned in the mailbox and must never
 * decrease (RFC 3501 §2.3.1.1). Deriving it from a `MAX(uid)` over the
 * mailbox's surviving rows violates both the moment the highest-UID mail is
 * expunged or hard-deleted, so it has to read `mail_uid_counters` — the same
 * row the reservation increments — without consuming a UID.
 */
describe("UIDNEXT peek", () => {
  it("reads the counter row without allocating — no INSERT, no DO UPDATE", () => {
    for (const { sql } of [
      buildDomainUidNextQuery(userId, false),
      buildAccountUidNextQuery(userId, "user@hoie.kim", false),
    ]) {
      expect(sql).toContain(`FROM ${mailUidCountersTable.name}`);
      expect(sql).not.toContain("INSERT");
      expect(sql).not.toContain("DO UPDATE");
      // The counter holds the LAST assigned UID, so UIDNEXT is that plus one.
      expect(sql).toContain(`SELECT ${LAST_UID} + 1`);
    }
  });

  it("targets the same counter row the reservation writes", () => {
    const peek = buildDomainUidNextQuery(userId, true);
    const reserve = buildDomainUidQuery(userId, true);
    // The key columns and their values must match, or the peek predicts a
    // sequence that nothing assigns from.
    for (const col of [USER_ID, UID_KIND, UID_SCOPE, SENT]) {
      expect(peek.sql).toContain(col);
    }
    expect(peek.values.slice(0, 4)).toEqual(reserve.values.slice(0, 4));

    const accountPeek = buildAccountUidNextQuery(userId, "user@hoie.kim", false);
    const accountReserve = buildAccountUidQuery(userId, "user@hoie.kim", false);
    expect(accountPeek.values).toEqual(accountReserve.values);
  });

  it("falls back to the reservation's own seed when no counter row exists yet", () => {
    // A scope that has never reserved (legacy mail predating the counter) must
    // still report a UIDNEXT above its existing UIDs. COALESCEing onto the
    // identical seed the first reservation would insert is what makes the
    // peek and that first allocation agree.
    const domain = buildDomainUidNextQuery(userId, false);
    expect(domain.sql).toContain("COALESCE(");
    expect(domain.sql).toContain("COALESCE(MAX(uid_domain), 0) + 1");

    const account = buildAccountUidNextQuery(userId, "user@hoie.kim", false);
    expect(account.sql).toContain("COALESCE(MAX(uid), 0) + 1 FROM mail_mailbox_uid");
    expect(account.values[4]).toBe("INBOX/accounts/user");
    expect(account.values[5]).toBe("user");
  });

  it("never sources UIDNEXT from a MAX over live `mails` rows", () => {
    // The regression itself: `MAX(uid)` filtered to non-expunged rows drops
    // when the highest-UID mail leaves, handing back a UID already assigned.
    for (const { sql } of [
      buildDomainUidNextQuery(userId, false),
      buildAccountUidNextQuery(userId, "user@hoie.kim", false),
    ]) {
      expect(sql).not.toContain("expunged");
    }
  });
});
