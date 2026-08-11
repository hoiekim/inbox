/**
 * The invalid-leftover sweep is the load-bearing half of the concurrent
 * index build: a `CREATE INDEX CONCURRENTLY` that fails leaves the index in
 * the catalog marked invalid, and `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
 * then matches it by name and no-ops. Without the sweep the retry can never
 * succeed, and the failure mode is a boot log that looks clean forever while
 * the index stays unusable (#746).
 *
 * Same FakePool pattern the other postgres tests use.
 */
import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(
  async (_sql: string, _values?: unknown[]) =>
    ({ rows: [] as unknown[], rowCount: 0 as number | null })
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

const { runBootMaintenance } = await import("./maintenance");
const { resetPool } = await import("./client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

const INDEXES = [
  { name: "idx_alpha", sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alpha ON t (a)" },
  { name: "idx_beta", sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_beta ON t (b)" },
];
const STATEMENTS = [{ name: "reindex", sql: "UPDATE t SET v = 1" }];
const work = () => ({ indexes: INDEXES, statements: STATEMENTS });

/**
 * Drives the session mock. `invalid` is what the `pg_index` probe reports;
 * `fail` throws for any statement whose text contains one of its entries.
 */
const arrange = (options: { invalid?: string[]; fail?: string[]; locked?: boolean } = {}) => {
  const { invalid = [], fail = [], locked = true } = options;
  const seen: string[] = [];
  mockQuery.mockImplementation(async (sql: string) => {
    const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
    seen.push(text);
    if (text.includes("pg_try_advisory_lock")) {
      return { rows: [{ locked }], rowCount: 1 };
    }
    if (text.includes("FROM pg_index")) {
      return { rows: invalid.map((relname) => ({ relname })), rowCount: invalid.length };
    }
    if (fail.some((needle) => text.includes(needle))) {
      throw new Error(`boom: ${text}`);
    }
    return { rows: [], rowCount: 0 };
  });
  return seen;
};

describe("runBootMaintenance — invalid-leftover sweep", () => {
  it("drops an invalid leftover before rebuilding it", async () => {
    const seen = arrange({ invalid: ["idx_beta"] });
    expect(await runBootMaintenance(work())).toBe(true);

    const drop = seen.findIndex((s) => s.startsWith("DROP INDEX CONCURRENTLY"));
    const rebuild = seen.indexOf(INDEXES[1].sql);
    expect(seen[drop]).toBe("DROP INDEX CONCURRENTLY IF EXISTS idx_beta");
    expect(drop).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(drop);
  });

  it("drops nothing when no index is invalid", async () => {
    const seen = arrange();
    expect(await runBootMaintenance(work())).toBe(true);
    expect(seen.filter((s) => s.startsWith("DROP INDEX"))).toEqual([]);
  });

  it("asks the catalog only about the indexes it owns, in its own schema", async () => {
    const seen = arrange();
    await runBootMaintenance(work());
    const probe = seen.find((s) => s.includes("FROM pg_index"));
    expect(probe).toContain("NOT i.indisvalid");
    expect(probe).toContain("n.nspname = current_schema()");
    expect(probe).toContain("c.relname = ANY($1)");
  });

  // A failed DROP means the leftover is still there, so the CREATE that
  // follows would silently no-op against it. Reporting that build as a success
  // is what would strand the index behind a written marker.
  it("skips — and does not claim success for — an index whose DROP failed", async () => {
    const seen = arrange({ invalid: ["idx_beta"], fail: ["DROP INDEX"] });
    expect(await runBootMaintenance(work())).toBe(false);
    expect(seen).not.toContain(INDEXES[1].sql);
    // The unaffected index and the trailing statements still run.
    expect(seen).toContain(INDEXES[0].sql);
    expect(seen).toContain(STATEMENTS[0].sql);
  });

  it("still attempts every build when the probe itself fails", async () => {
    const seen = arrange({ fail: ["FROM pg_index"] });
    expect(await runBootMaintenance(work())).toBe(true);
    expect(seen).toContain(INDEXES[0].sql);
    expect(seen).toContain(INDEXES[1].sql);
  });
});

describe("runBootMaintenance — session and locking", () => {
  it("runs nothing when another instance holds the lock", async () => {
    const seen = arrange({ locked: false });
    expect(await runBootMaintenance(work())).toBe(false);
    expect(seen.filter((s) => s.startsWith("CREATE INDEX"))).toEqual([]);
    expect(seen).not.toContain(STATEMENTS[0].sql);
  });

  it("raises the session statement_timeout above the pool default", async () => {
    const seen = arrange();
    await runBootMaintenance(work());
    const set = seen.find((s) => s.startsWith("SET statement_timeout"));
    expect(set).toBeDefined();
    const budget = Number(set!.match(/=\s*(\d+)/)![1]);
    expect(budget).toBeGreaterThan(30_000);
  });

  it("releases the advisory lock even when a statement throws", async () => {
    const seen = arrange({ fail: ["CREATE INDEX"] });
    expect(await runBootMaintenance(work())).toBe(false);
    expect(seen.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("does not release a lock it never acquired", async () => {
    const seen = arrange({ locked: false });
    await runBootMaintenance(work());
    expect(seen.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);
  });

  it("reports failure without throwing when every statement fails", async () => {
    arrange({ fail: ["CREATE INDEX", "UPDATE t"] });
    expect(await runBootMaintenance(work())).toBe(false);
  });
});
