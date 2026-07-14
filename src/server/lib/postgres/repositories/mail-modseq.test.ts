/**
 * CONDSTORE phase 1 (#607) — per-message mod-sequence groundwork (RFC 7162).
 *
 * `getNextModseq` MUST reserve through the same atomic `mail_uid_counters`
 * upsert as UID assignment (INSERT … ON CONFLICT … DO UPDATE last_uid + 1),
 * NOT a bare `SELECT MAX(modseq)+1` read — the bare read is the TOCTOU that let
 * two concurrent mutations claim the same value (#617, same class of bug for
 * UIDs). The counter is keyed by kind="modseq" so it never collides with the
 * domain/account UID rows.
 *
 * Pure `build*` helpers pin the SQL shape with no pool interception (mock.module
 * on the shared `../client` bleeds across the whole suite). The monotonic
 * concurrency proof — N parallel reservations yield strictly distinct, ascending
 * mod-sequences — is the disposable-DB E2E in the PR body.
 */

import { describe, it, expect } from "bun:test";
import { buildModseqQuery } from "./mails";
import { mailsTable } from "../models";
import { USER_ID, UID_KIND, UID_SCOPE, SENT, LAST_UID, MODSEQ } from "../models";

const userId = "11111111-1111-1111-1111-111111111111";

describe("buildModseqQuery", () => {
  it("reserves atomically via INSERT … ON CONFLICT DO UPDATE on mail_uid_counters", () => {
    const { sql } = buildModseqQuery(userId);
    expect(sql).toContain("INSERT INTO mail_uid_counters");
    expect(sql).toContain(
      `ON CONFLICT (${USER_ID}, ${UID_KIND}, ${UID_SCOPE}, ${SENT})`
    );
    expect(sql).toContain(
      `DO UPDATE SET ${LAST_UID} = mail_uid_counters.${LAST_UID} + 1`
    );
    expect(sql).toContain(`RETURNING ${LAST_UID} AS next_uid`);
  });

  it("seeds once from the live MAX(modseq) so the counter starts above the backfill floor", () => {
    const { sql } = buildModseqQuery(userId);
    expect(sql).toContain(`COALESCE(MAX(${MODSEQ}), 0) + 1`);
  });

  it("does NOT issue the racy bare MAX(modseq)+1 read as the assignment", () => {
    const { sql } = buildModseqQuery(userId);
    expect(sql).not.toContain("AS next_uid FROM mails");
  });

  it("keys the counter kind='modseq' (scope='', sent=false unused) so it never collides with a UID row", () => {
    const { values } = buildModseqQuery(userId);
    expect(values).toEqual([userId, "modseq", "", false]);
  });
});

describe("mails.modseq column (CONDSTORE groundwork)", () => {
  it("declares modseq as BIGINT NOT NULL DEFAULT 1 (DEFAULT doubles as the single-pass backfill)", () => {
    const def = (mailsTable.schema as Record<string, string>)[MODSEQ];
    expect(def).toBe("BIGINT NOT NULL DEFAULT 1");
  });

  it("indexes modseq so per-mailbox HIGHESTMODSEQ (MAX(modseq)) is cheap", () => {
    const indexed = mailsTable.indexes.some((i) => i.column === MODSEQ);
    expect(indexed).toBe(true);
  });
});
