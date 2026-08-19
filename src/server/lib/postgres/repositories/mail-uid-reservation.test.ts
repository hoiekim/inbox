
import { describe, it, expect } from "bun:test";
import {
  buildDomainUidQuery,
  buildAccountUidQuery,
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
