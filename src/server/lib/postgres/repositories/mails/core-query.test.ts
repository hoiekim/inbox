/**
 * SQL-shape guards for the core mail mutations, asserted on what the builders
 * emit rather than on the text of the functions that build it.
 */

import { describe, it, expect } from "bun:test";
import { buildMailExistsQuery, buildMarkMailSpamQuery } from "./core-query";

const USER = "11111111-1111-1111-1111-111111111111";
const MAIL = "22222222-2222-2222-2222-222222222222";

describe("buildMarkMailSpamQuery", () => {
  it("stamps the mod-sequence the caller reserved", () => {
    // The flip moves the mail out of INBOX, so it has to advance
    // HIGHESTMODSEQ or a CONDSTORE client reads an unchanged value and never
    // resyncs.
    const { sql, values } = buildMarkMailSpamQuery(USER, MAIL, true, 41);
    expect(sql).toContain("modseq = $4");
    expect(values[3]).toBe(41);
  });

  it("matches no row when the flag already holds the requested value", () => {
    // Idempotence guard: a re-mark must leave the reserved mod-sequence
    // unused rather than announce a change that did not happen.
    expect(buildMarkMailSpamQuery(USER, MAIL, true, 41).sql).toContain(
      "is_spam IS DISTINCT FROM $1"
    );
  });

  it("scopes the update to one mail owned by the caller", () => {
    const { sql, values } = buildMarkMailSpamQuery(USER, MAIL, false, 7);
    expect(sql).toContain("WHERE mail_id = $2 AND user_id = $3");
    expect(values).toEqual([false, MAIL, USER, 7]);
  });

  it("refreshes `updated` so delta-sync clients evict the row", () => {
    expect(buildMarkMailSpamQuery(USER, MAIL, true, 1).sql).toContain(
      "updated = NOW()"
    );
  });

  it("returns the touched id so the caller can tell a miss from a no-op", () => {
    expect(buildMarkMailSpamQuery(USER, MAIL, true, 1).sql).toContain(
      "RETURNING mail_id"
    );
  });
});

describe("buildMailExistsQuery", () => {
  it("probes one row scoped to the owner", () => {
    const { sql, values } = buildMailExistsQuery(USER, MAIL);
    expect(sql).toContain("WHERE mail_id = $1 AND user_id = $2");
    expect(sql).toContain("LIMIT 1");
    expect(values).toEqual([MAIL, USER]);
  });
});
