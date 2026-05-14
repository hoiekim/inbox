/**
 * Unit tests for SpamAllowlistTable methods.
 *
 * Verifies the SQL string + parameter normalization layer that wraps the DB.
 * Pool is mocked — no live PostgreSQL needed.
 *
 * Specifically covers the regression from #483: addEntry's ON CONFLICT clause
 * references (user_id, pattern) and must match the table's UNIQUE constraint.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

type Captured = { sql: string; params: unknown[] };
const captured: Captured[] = [];
let nextRows: unknown[] = [];
let nextRowCount: number | null = null;

const mockPoolQuery = mock(async (sql: string, params?: unknown[]) => {
  captured.push({ sql, params: params ?? [] });
  const rows = nextRows;
  const rowCount = nextRowCount;
  // Reset so each call's plant is one-shot.
  nextRows = [];
  nextRowCount = null;
  return { rows, rowCount };
});

mock.module("../client", () => ({ pool: { query: mockPoolQuery } }));

// Import only AFTER the pool mock is in place so the module resolves to it.
import {
  spamAllowlistTable,
  SpamAllowlistModel,
  PATTERN,
} from "./spam_allowlist";
import { USER_ID } from "./common";

beforeEach(() => {
  captured.length = 0;
  nextRows = [];
  nextRowCount = null;
});

describe("SpamAllowlistTable constraint declaration", () => {
  it("declares UNIQUE(user_id, pattern) — must match addEntry's ON CONFLICT clause", () => {
    expect(spamAllowlistTable.constraints).toContain(`UNIQUE(${USER_ID}, ${PATTERN})`);
  });
});

describe("SpamAllowlistTable.addEntry", () => {
  const userId = "11111111-1111-1111-1111-111111111111";

  it("issues an INSERT … ON CONFLICT (user_id, pattern) DO NOTHING", async () => {
    nextRows = [
      {
        allowlist_id: "aaaa",
        user_id: userId,
        pattern: "alice@example.com",
        created_at: "2026-05-14T00:00:00Z",
      },
    ];
    const result = await spamAllowlistTable.addEntry(userId, "alice@example.com");
    expect(result).toBeInstanceOf(SpamAllowlistModel);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("INSERT INTO spam_allowlist");
    expect(captured[0].sql).toContain(`ON CONFLICT (${USER_ID}, ${PATTERN})`);
    expect(captured[0].sql).toContain("DO NOTHING");
    expect(captured[0].sql).toContain("RETURNING *");
  });

  it("lowercases the pattern before insertion", async () => {
    nextRows = [
      {
        allowlist_id: "bbbb",
        user_id: userId,
        pattern: "alice@example.com",
        created_at: "2026-05-14T00:00:00Z",
      },
    ];
    await spamAllowlistTable.addEntry(userId, "ALICE@Example.COM");
    expect(captured[0].params).toEqual([userId, "alice@example.com"]);
  });

  it("returns null when no row is returned (duplicate hit)", async () => {
    nextRows = [];
    const result = await spamAllowlistTable.addEntry(userId, "alice@example.com");
    expect(result).toBeNull();
  });
});

describe("SpamAllowlistTable.isAllowlisted", () => {
  const userId = "22222222-2222-2222-2222-222222222222";

  it("queries with both exact and *@domain forms (lowercased)", async () => {
    nextRows = [{ count: "1" }];
    const result = await spamAllowlistTable.isAllowlisted(userId, "BOB@Example.COM");
    expect(result).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("COUNT(*) AS count");
    expect(captured[0].params).toEqual([userId, "bob@example.com", "*@example.com"]);
  });

  it("returns false when the COUNT is zero", async () => {
    nextRows = [{ count: "0" }];
    const result = await spamAllowlistTable.isAllowlisted(userId, "stranger@unknown.com");
    expect(result).toBe(false);
  });

  it("returns false when the COUNT row is missing", async () => {
    nextRows = [];
    const result = await spamAllowlistTable.isAllowlisted(userId, "x@y.com");
    expect(result).toBe(false);
  });
});

describe("SpamAllowlistTable.removeByPattern", () => {
  const userId = "33333333-3333-3333-3333-333333333333";

  it("issues a DELETE filtered by user_id and LOWER(pattern), lowercases input", async () => {
    nextRowCount = 1;
    const ok = await spamAllowlistTable.removeByPattern(userId, "Alice@Example.com");
    expect(ok).toBe(true);
    expect(captured[0].sql).toContain("DELETE FROM spam_allowlist");
    expect(captured[0].sql).toContain(`LOWER(${PATTERN}) = $2`);
    expect(captured[0].params).toEqual([userId, "alice@example.com"]);
  });

  it("returns false when no row matched (rowCount === 0)", async () => {
    nextRowCount = 0;
    const ok = await spamAllowlistTable.removeByPattern(userId, "ghost@example.com");
    expect(ok).toBe(false);
  });

  it("treats missing rowCount as zero (returns false)", async () => {
    nextRowCount = null;
    const ok = await spamAllowlistTable.removeByPattern(userId, "ghost@example.com");
    expect(ok).toBe(false);
  });
});

describe("SpamAllowlistTable.removeById", () => {
  const userId = "44444444-4444-4444-4444-444444444444";
  const allowlistId = "55555555-5555-5555-5555-555555555555";

  it("scopes the DELETE by both user_id and allowlist_id to prevent cross-user delete", async () => {
    nextRowCount = 1;
    const ok = await spamAllowlistTable.removeById(userId, allowlistId);
    expect(ok).toBe(true);
    expect(captured[0].sql).toContain("DELETE FROM spam_allowlist");
    expect(captured[0].sql).toContain(`${USER_ID} = $1`);
    expect(captured[0].sql).toContain("allowlist_id = $2");
    expect(captured[0].params).toEqual([userId, allowlistId]);
  });

  it("returns false when no row matched", async () => {
    nextRowCount = 0;
    const ok = await spamAllowlistTable.removeById(userId, allowlistId);
    expect(ok).toBe(false);
  });
});

describe("SpamAllowlistTable.getAllForUser", () => {
  const userId = "66666666-6666-6666-6666-666666666666";

  it("returns SELECT * filtered by user_id, newest first", async () => {
    nextRows = [
      {
        allowlist_id: "z",
        user_id: userId,
        pattern: "p1",
        created_at: "2026-05-14T00:00:00Z",
      },
      {
        allowlist_id: "y",
        user_id: userId,
        pattern: "p2",
        created_at: "2026-05-13T00:00:00Z",
      },
    ];
    const result = await spamAllowlistTable.getAllForUser(userId);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(SpamAllowlistModel);
    expect(captured[0].sql).toContain("SELECT * FROM spam_allowlist");
    expect(captured[0].sql).toContain(`${USER_ID} = $1`);
    expect(captured[0].sql).toContain("ORDER BY created_at DESC");
    expect(captured[0].params).toEqual([userId]);
  });

  it("returns an empty array when the user has no entries", async () => {
    nextRows = [];
    const result = await spamAllowlistTable.getAllForUser(userId);
    expect(result).toEqual([]);
  });
});
