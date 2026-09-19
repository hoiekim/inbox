
import { describe, it, expect, mock, beforeEach } from "bun:test";

type Captured = { sql: string; params: unknown[] };
const captured: Captured[] = [];
let nextRows: unknown[] = [];
let nextRowCount: number | null = null;

// A plant for one query. `planned` feeds calls in order for the paths that
// issue more than one; `nextRows`/`nextRowCount` remain the single-call form.
let planned: { rows: unknown[]; rowCount: number | null }[] = [];

const mockPoolQuery = mock(async (sql: string, params?: unknown[]) => {
  captured.push({ sql, params: params ?? [] });
  if (planned.length) return planned.shift()!;
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
  ALLOWLIST_COUNT_MAX,
  ALLOWLIST_PATTERN_MAX_BYTES,
  PATTERN,
} from "./spam_allowlist";
import { USER_ID } from "./common";

beforeEach(() => {
  captured.length = 0;
  planned = [];
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
  const createdRow = {
    allowlist_id: "aaaa",
    user_id: userId,
    pattern: "alice@example.com",
    created_at: "2026-05-14T00:00:00Z",
  };

  it("issues an INSERT … ON CONFLICT (user_id, pattern) DO NOTHING", async () => {
    nextRows = [createdRow];
    const result = await spamAllowlistTable.addEntry(userId, "alice@example.com");
    expect(result.status).toBe("created");
    expect(result.status === "created" && result.entry).toBeInstanceOf(SpamAllowlistModel);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("INSERT INTO spam_allowlist");
    expect(captured[0].sql).toContain(`ON CONFLICT (${USER_ID}, ${PATTERN})`);
    expect(captured[0].sql).toContain("DO NOTHING");
    expect(captured[0].sql).toContain("RETURNING *");
  });

  it("lowercases the pattern before insertion", async () => {
    nextRows = [createdRow];
    await spamAllowlistTable.addEntry(userId, "ALICE@Example.COM");
    expect(captured[0].params).toEqual([
      userId,
      "alice@example.com",
      ALLOWLIST_COUNT_MAX,
    ]);
  });

  it("gates the INSERT on the user's row count, passing the ceiling as a parameter", async () => {
    nextRows = [createdRow];
    await spamAllowlistTable.addEntry(userId, "alice@example.com");
    expect(captured[0].sql).toContain("SELECT COUNT(*)");
    expect(captured[0].sql).toContain(`WHERE ${USER_ID} = $1) < $3`);
    expect(captured[0].params[2]).toBe(ALLOWLIST_COUNT_MAX);
  });

  it("reports `exists` when the write produced no row and the pattern is present", async () => {
    planned = [
      { rows: [], rowCount: 0 },
      { rows: [{ "?column?": 1 }], rowCount: 1 },
    ];
    const result = await spamAllowlistTable.addEntry(userId, "alice@example.com");
    expect(result).toEqual({ status: "exists" });
    expect(captured).toHaveLength(2);
    expect(captured[1].sql).toContain("SELECT 1 FROM spam_allowlist");
  });

  it("reports `at_limit` when the write produced no row and the pattern is absent", async () => {
    planned = [
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ];
    const result = await spamAllowlistTable.addEntry(userId, "new@example.com");
    expect(result).toEqual({ status: "at_limit" });
  });

  it("probes for the pattern before concluding `at_limit` — an existing entry at the ceiling still reports as existing", async () => {
    planned = [
      { rows: [], rowCount: 0 },
      { rows: [{ "?column?": 1 }], rowCount: 1 },
    ];
    const result = await spamAllowlistTable.addEntry(userId, "alice@example.com");
    expect(result.status).not.toBe("at_limit");
    expect(result.status).toBe("exists");
  });

  it("refuses a pattern over the byte ceiling without issuing a query", async () => {
    const localPart = "a".repeat(ALLOWLIST_PATTERN_MAX_BYTES);
    const result = await spamAllowlistTable.addEntry(userId, `${localPart}@example.com`);
    expect(result).toEqual({ status: "too_long" });
    expect(captured).toHaveLength(0);
  });

  it("measures the ceiling in UTF-8 bytes, not characters", async () => {
    // 200 two-byte characters count as 200 towards `String.length` and 400
    // towards the measure the column actually stores.
    const pattern = `${"é".repeat(200)}@example.com`;
    expect(pattern.length).toBeLessThan(ALLOWLIST_PATTERN_MAX_BYTES);
    expect(Buffer.byteLength(pattern, "utf8")).toBeGreaterThan(ALLOWLIST_PATTERN_MAX_BYTES);
    const result = await spamAllowlistTable.addEntry(userId, pattern);
    expect(result).toEqual({ status: "too_long" });
    expect(captured).toHaveLength(0);
  });

  it("accepts a pattern exactly at the byte ceiling", async () => {
    const localPart = "a".repeat(ALLOWLIST_PATTERN_MAX_BYTES - "@example.com".length);
    const pattern = `${localPart}@example.com`;
    expect(Buffer.byteLength(pattern, "utf8")).toBe(ALLOWLIST_PATTERN_MAX_BYTES);
    nextRows = [{ ...createdRow, pattern }];
    const result = await spamAllowlistTable.addEntry(userId, pattern);
    expect(result.status).toBe("created");
    expect(captured).toHaveLength(1);
  });
});

describe("allowlist ceilings", () => {
  it("bounds the pattern at the longest address RFC 5321 permits", () => {
    expect(ALLOWLIST_PATTERN_MAX_BYTES).toBe(320);
  });

  it("caps rows per user", () => {
    expect(ALLOWLIST_COUNT_MAX).toBe(1000);
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
