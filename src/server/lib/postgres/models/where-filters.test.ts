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
 * Uses the native `mock.module("pg")` FakePool seam (mirrors `users.test.ts`)
 * so the real `Table` methods run against an intercepted `pool.query`.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(
  async (_sql: string, _values?: unknown[]) => ({
    rows: [] as unknown[],
    rowCount: 0 as number | null,
  })
);

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const { mailsTable } = await import("../models");
const { resetPool } = await import("../client");

const USER_ID = "11111111-1111-1111-1111-111111111111";
const MAIL_ID = "22222222-2222-2222-2222-222222222222";

beforeAll(() => {
  // `mock.module` is process-global — re-assert right before this file's tests
  // in case a sibling restored `pg` and instantiated the lazy pool for real.
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

beforeEach(() => mockQuery.mockClear());

const lastSql = () => String(mockQuery.mock.calls.at(-1)?.[0] ?? "");

describe("updateWhere rejects an undefined filter value", () => {
  it("throws instead of widening the UPDATE to every row of the surviving predicate", async () => {
    await expect(
      mailsTable.updateWhere(
        { mail_id: undefined, user_id: USER_ID },
        { read: true }
      )
    ).rejects.toThrow(/updateWhere received undefined for mail_id/);
  });

  it("issues no statement at all when it refuses", async () => {
    await mailsTable
      .updateWhere({ mail_id: undefined, user_id: USER_ID }, { read: true })
      .catch(() => {});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("names every undefined column, not just the first", async () => {
    await expect(
      mailsTable.updateWhere(
        { mail_id: undefined, message_id: undefined, user_id: USER_ID },
        { read: true }
      )
    ).rejects.toThrow(/mail_id, message_id/);
  });

  it("still emits the scoped UPDATE when mail_id is present", async () => {
    await mailsTable.updateWhere(
      { mail_id: MAIL_ID, user_id: USER_ID },
      { read: true }
    );
    expect(lastSql()).toContain("mail_id = $");
    expect(lastSql()).toContain("user_id = $");
  });

  it("keeps the spread idiom working — an absent key is not an undefined key", async () => {
    const quarantined = false;
    await mailsTable.updateWhere(
      {
        user_id: USER_ID,
        expunged: false,
        ...(quarantined ? { is_spam: false } : {}),
      },
      { expunged: true }
    );
    expect(lastSql()).toContain("user_id = $");
    expect(lastSql()).toContain("expunged = $");
    expect(lastSql()).not.toContain("is_spam");
  });

  it("still refuses an entirely empty filter bag", async () => {
    await expect(
      mailsTable.updateWhere({}, { read: true })
    ).rejects.toThrow(/requires at least one filter/);
  });
});

describe("deleteWhere rejects an undefined filter value", () => {
  it("throws instead of deleting every row of the surviving predicate", async () => {
    await expect(
      mailsTable.deleteWhere({ mail_id: undefined, user_id: USER_ID })
    ).rejects.toThrow(/deleteWhere received undefined for mail_id/);
  });

  it("issues no statement at all when it refuses", async () => {
    await mailsTable
      .deleteWhere({ mail_id: undefined, user_id: USER_ID })
      .catch(() => {});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("still emits the scoped DELETE when mail_id is present", async () => {
    await mailsTable.deleteWhere({ mail_id: MAIL_ID, user_id: USER_ID });
    expect(lastSql()).toContain("DELETE FROM mails");
    expect(lastSql()).toContain("mail_id = $");
    expect(lastSql()).toContain("user_id = $");
  });

  it("still refuses an entirely empty filter bag", async () => {
    await expect(mailsTable.deleteWhere({})).rejects.toThrow(
      /requires at least one filter/
    );
  });
});
