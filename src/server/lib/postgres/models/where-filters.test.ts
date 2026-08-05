/**
 * `updateWhere` / `deleteWhere` must refuse a filter key that was passed with
 * an `undefined` value (#790).
 *
 * Dropping undefined is the right default for optional *search* filters, but on
 * a mutation it removes the predicate the caller meant to apply and widens the
 * statement to every row the surviving predicates match. `POST /api/mails/mark`
 * with no `mail_id` reached `updateWhere({ mail_id: undefined, user_id })`,
 * which emitted `UPDATE mails SET read = $1 WHERE user_id = $2` — the caller's
 * entire mailbox.
 *
 * A key that was never passed is absent from `Object.entries` and must keep
 * working, so the `...(condition ? { column: value } : {})` spread idiom used
 * across the IMAP expunge paths is exercised here too.
 *
 * Tests the pure `resolveMutationFilters` rather than intercepting `pool.query`
 * — `mock.module` on the shared `../client` is process-global and bleeds across
 * the suite (same rationale as the `build*` helper tests in
 * `repositories/mail-modseq.test.ts`).
 */

import { describe, it, expect } from "bun:test";
import { resolveMutationFilters } from "./base";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const MAIL_ID = "22222222-2222-2222-2222-222222222222";

const columnsOf = (entries: [string, unknown][]) => entries.map(([c]) => c);

describe("resolveMutationFilters rejects an undefined filter value", () => {
  it("throws rather than dropping the predicate and widening the statement", () => {
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow(/updateWhere received undefined for mail_id/);
  });

  it("names the calling method so the error points at the right builder", () => {
    expect(() =>
      resolveMutationFilters("deleteWhere", {
        mail_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow(/deleteWhere received undefined for mail_id/);
  });

  it("names every undefined column, not just the first", () => {
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: undefined,
        message_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow(/mail_id, message_id/);
  });

  it("refuses even when a scoping column survives — the mailbox-wide case", () => {
    // This is the exact shape `markRead(user.id, undefined)` produced.
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow();
  });

  it("still refuses an entirely empty filter bag", () => {
    expect(() => resolveMutationFilters("updateWhere", {})).toThrow(
      /updateWhere requires at least one filter/
    );
    expect(() => resolveMutationFilters("deleteWhere", {})).toThrow(
      /deleteWhere requires at least one filter/
    );
  });
});

describe("resolveMutationFilters keeps every legitimate filter shape", () => {
  it("returns both predicates for the scoped id + owner case", () => {
    const entries = resolveMutationFilters("updateWhere", {
      mail_id: MAIL_ID,
      user_id: USER_ID,
    });
    expect(columnsOf(entries)).toEqual(["mail_id", "user_id"]);
    expect(entries).toEqual([
      ["mail_id", MAIL_ID],
      ["user_id", USER_ID],
    ]);
  });

  it("keeps the spread idiom working — an absent key is not an undefined key", () => {
    const quarantined = false;
    const entries = resolveMutationFilters("updateWhere", {
      user_id: USER_ID,
      sent: false,
      expunged: false,
      ...(quarantined ? { is_spam: false } : {}),
    });
    expect(columnsOf(entries)).toEqual(["user_id", "sent", "expunged"]);
  });

  it("includes the conditional key when the spread does fire", () => {
    const quarantined = true;
    const entries = resolveMutationFilters("updateWhere", {
      user_id: USER_ID,
      expunged: false,
      ...(quarantined ? { is_spam: false } : {}),
    });
    expect(columnsOf(entries)).toEqual(["user_id", "expunged", "is_spam"]);
  });

  it("passes FilterCondition objects through untouched (IN-list expunge path)", () => {
    const condition = { op: "IN" as const, value: [MAIL_ID] };
    const entries = resolveMutationFilters("updateWhere", {
      mail_id: condition,
    });
    expect(entries).toEqual([["mail_id", condition]]);
  });

  it("treats false, 0, empty string and null as real predicates, not as missing", () => {
    const entries = resolveMutationFilters("deleteWhere", {
      expunged: false,
      uid_domain: 0,
      subject: "",
      insight: null,
    });
    expect(columnsOf(entries)).toEqual([
      "expunged",
      "uid_domain",
      "subject",
      "insight",
    ]);
  });
});

describe("Table wires both mutation builders through the guard", () => {
  it("updateWhere and deleteWhere both call resolveMutationFilters", async () => {
    // Source-level assertion in the style of `repositories/mails/imap.test.ts`:
    // the guard is only worth anything if neither builder can drift back to a
    // raw `Object.entries(filters).filter(...)`.
    const source = await Bun.file(
      new URL("./base.ts", import.meta.url).pathname
    ).text();
    const updateWhere = source.slice(source.indexOf("async updateWhere("));
    const deleteWhere = source.slice(source.indexOf("async deleteWhere("));

    // Asserted as booleans so a failure prints a one-line diff, not the file.
    expect(
      updateWhere.includes('resolveMutationFilters("updateWhere", filters)')
    ).toBe(true);
    expect(
      deleteWhere.includes('resolveMutationFilters("deleteWhere", filters)')
    ).toBe(true);
    // The data bag legitimately still drops undefined — only filters are strict.
    expect(
      source.includes(
        "Object.entries(filters).filter(([, v]) => v !== undefined)"
      )
    ).toBe(false);
  });
});
