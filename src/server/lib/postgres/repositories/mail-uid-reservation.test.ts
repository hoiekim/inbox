/**
 * Regression guard for the UID-assignment race (#617).
 *
 * `getDomainUidNext` / `getAccountUidNext` MUST assign UIDs through the atomic
 * `mail_uid_counters` upsert (INSERT … ON CONFLICT … DO UPDATE last_uid + 1),
 * NOT a bare `SELECT MAX(uid)+1` read. The bare read is a TOCTOU: two concurrent
 * mail receipts read the same max and write the same UID, corrupting the mailbox
 * (RFC 3501 §2.3.1.1 — UIDs must be unique and strictly ascending).
 *
 * The SQL is built by pure `build*UidQuery` helpers so this pins the shape with
 * no pool interception (mock.module on the shared `../client` bleeds across the
 * full suite). The actual concurrency proof — N parallel reservations yield
 * strictly distinct UIDs — is the disposable-DB E2E in the PR body.
 */

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
    expect(sql).toContain("COALESCE(MAX(uid_account), 0) + 1");
    expect(values[1]).toBe("account");
    expect(values[2]).toBe("user@hoie.kim");
    expect(values[3]).toBe(false);
    // jsonb match payload preserved for the seed's address-containment.
    expect(values[4]).toBe(JSON.stringify([{ address: "user@hoie.kim" }]));
  });

  it("seeds the received sequence from to/cc/bcc/envelope containment", () => {
    const { sql } = buildAccountUidQuery(userId, "user@hoie.kim", false);
    expect(sql).toContain("to_address @> $5::jsonb");
    expect(sql).toContain("cc_address @> $5::jsonb");
    expect(sql).toContain("bcc_address @> $5::jsonb");
    expect(sql).toContain("envelope_to @> $5::jsonb");
  });

  it("seeds the sent sequence from from_address containment", () => {
    const { sql, values } = buildAccountUidQuery(userId, "user@hoie.kim", true);
    expect(sql).toContain("from_address @> $5::jsonb");
    expect(sql).not.toContain("to_address @> $5::jsonb");
    expect(values[3]).toBe(true);
  });
});
