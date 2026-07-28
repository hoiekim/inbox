/**
 * `ensureMailboxUids` source-shape tests. The runtime shape (backfill
 * from mails.uid_account, race safety via ON CONFLICT DO NOTHING,
 * complete map return) is verified end-to-end by the PR 2b-2 sandbox
 * E2E — this file guards the SQL shape against silent regression when
 * future edits touch the counter/mapping paths.
 *
 * Pattern mirrors `imap.test.ts`'s existing source-scan style: read the
 * function body as text and assert on the SQL fragments and control
 * shape. That's stable against `mock.module` bleed (per
 * feedback_bun_mock_module_global_hoisting) and doesn't need a live pg.
 */
import { describe, it, expect, beforeAll } from "bun:test";

describe("ensureMailboxUids source shape (#702 PR 2b-1)", () => {
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "counters.ts"),
      "utf8"
    );
    const match = source.match(/export const ensureMailboxUids[\s\S]*?\n};/);
    if (!match) throw new Error("ensureMailboxUids not found in counters.ts");
    fnSource = match[0];
  });

  it("early-returns an empty Map for zero input mail_ids", () => {
    // No round-trip when the caller has nothing to look up.
    expect(fnSource).toMatch(/mail_ids\.length === 0/);
    expect(fnSource).toMatch(/return result/);
  });

  it("backfills missing rows in one round-trip via INSERT … SELECT anti-join", () => {
    // Server-side backfill: for each requested mail_id lacking a mapping,
    // mirror the mail's uid_account into mail_mailbox_uid. `NOT EXISTS`
    // narrows to the missing set so the INSERT is a no-op for rows PR 2a
    // already wrote.
    expect(fnSource).toMatch(/INSERT INTO \$\{MAIL_MAILBOX_UID\}/);
    expect(fnSource).toMatch(/SELECT m\.user_id, \$2, m\.mail_id, m\.uid_account/);
    expect(fnSource).toMatch(/FROM mails m/);
    expect(fnSource).toMatch(/WHERE m\.user_id = \$1/);
    expect(fnSource).toMatch(/mail_id = ANY\(\$3::text\[\]\)/);
    expect(fnSource).toMatch(/NOT EXISTS/);
  });

  it("filters uid_account > 0 so domain-only rows don't emit zero-UID mappings", () => {
    // Mails that were never account-routed (legacy or domain-only paths)
    // have uid_account = 0. Writing (mailbox, mail_id, 0) would occupy
    // the UNIQUE (user_id, mailbox, uid) slot for UID 0 and shadow the
    // legit first-account-mail UID for that mailbox. Skip them.
    expect(fnSource).toMatch(/uid_account\s*>\s*0/);
  });

  it("uses bare ON CONFLICT DO NOTHING (no target) to swallow BOTH constraint violations", () => {
    // `mail_mailbox_uid` has PRIMARY KEY (user_id, mailbox, mail_id) AND
    // UNIQUE (user_id, mailbox, uid). A target-scoped clause `ON
    // CONFLICT (user_id, mailbox, mail_id)` only catches the PK; a
    // duplicate-UID collision from legacy pre-#617-fix data (two mails
    // sharing the same uid_account for a mailbox) would still throw and
    // abort the WHOLE INSERT batch — every backfilled row lost, not just
    // the offender. Bare `ON CONFLICT DO NOTHING` swallows both, so good
    // rows persist even when a poisoned pair sits inside the batch.
    // Concurrent callers (two ensureMailboxUids racing on the same
    // missing tuple) still see idempotency from the PK path.
    expect(fnSource).toMatch(/ON CONFLICT\s+DO NOTHING/);
    // Guard against future edits reintroducing a target-scoped clause.
    expect(fnSource).not.toMatch(/ON CONFLICT\s*\([^)]+\)\s*DO NOTHING/);
  });

  it("re-reads the complete mapping so PR 2a rows AND fresh backfill rows land in the return Map", () => {
    // SELECT after the INSERT so rows PR 2a wrote at receive/send time
    // are returned in the same call — the caller sees a full picture
    // regardless of which write path populated the row.
    expect(fnSource).toMatch(/SELECT/);
    // Result populated from row iteration; keyed by mail_id, valued by uid.
    expect(fnSource).toMatch(/result\.set\(row\.mail_id, Number\(row\.uid\)\)/);
  });

  it("errors on backfill or read do not throw — best-effort semantics", () => {
    // The mapping is still non-authoritative in PR 2b-1. A missed
    // backfill row falls back to a subsequent call (or PR 2b-2's read
    // path degrading to mails.uid_account). Callers should not lose a
    // request over a mapping-layer transient.
    expect(fnSource).toMatch(/try \{/);
    expect(fnSource).toMatch(/catch \(error\)/);
    // Two try/catch blocks — one per pg round-trip.
    const catches = (fnSource.match(/catch \(error\)/g) ?? []).length;
    expect(catches).toBe(2);
  });
});
