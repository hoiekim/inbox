/**
 * Tests for the hash-based fast-path pre-flight in `checkSchemaAtTarget` /
 * `writeSchemaMarker`. Under a steady-state boot this is what determines
 * whether `initializePostgres` skips its ~35+ DDL round-trips or falls
 * through to the authoritative slow path.
 *
 * Same FakePool pattern the other repository tests use — mock `pg`, run
 * the real query through the pool, control the `schema_meta` response
 * per test.
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

const { checkSchemaAtTarget, writeSchemaMarker } = await import("./migration");
const { resetPool } = await import("./client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

describe("checkSchemaAtTarget — hash-based fast-path", () => {
  it("returns true when schema_meta.schema_hash matches expected", async () => {
    mockQuery.mockImplementation(async () => ({
      rows: [{ value: "abc123def4567890" }],
      rowCount: 1,
    }));
    expect(await checkSchemaAtTarget("abc123def4567890")).toBe(true);
  });

  it("returns false when the marker value differs (schema drifted)", async () => {
    mockQuery.mockImplementation(async () => ({
      rows: [{ value: "OLDHASH" }],
      rowCount: 1,
    }));
    expect(await checkSchemaAtTarget("NEWHASH")).toBe(false);
  });

  it("returns false when the marker row doesn't exist (first-ever boot)", async () => {
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    expect(await checkSchemaAtTarget("any")).toBe(false);
  });

  it("returns false when schema_meta table doesn't exist yet", async () => {
    // Simulates the pre-migration state: SELECT throws with
    // `relation "schema_meta" does not exist`. Fast path must fall
    // through — slow path creates the table and writes the marker.
    mockQuery.mockImplementation(async () => {
      throw new Error('relation "schema_meta" does not exist');
    });
    expect(await checkSchemaAtTarget("any")).toBe(false);
  });

  it("returns false on any query error — falls back to slow path", async () => {
    mockQuery.mockImplementation(async () => {
      throw new Error("connection timeout");
    });
    expect(await checkSchemaAtTarget("any")).toBe(false);
  });

  it("uses exactly ONE round-trip regardless of outcome", async () => {
    mockQuery.mockImplementation(async () => ({
      rows: [{ value: "MATCH" }],
      rowCount: 1,
    }));
    mockQuery.mockClear();
    await checkSchemaAtTarget("MATCH");
    expect(mockQuery.mock.calls.length).toBe(1);
  });
});

describe("writeSchemaMarker", () => {
  it("creates schema_meta if missing then upserts the hash", async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      calls.push([sql, values]);
      return { rows: [], rowCount: 0 };
    });
    mockQuery.mockClear();
    await writeSchemaMarker("MYHASH");
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toContain("CREATE TABLE IF NOT EXISTS schema_meta");
    expect(calls[1][0]).toContain("INSERT INTO schema_meta");
    expect(calls[1][0]).toContain("ON CONFLICT (key) DO UPDATE");
    expect(calls[1][1]).toEqual(["MYHASH"]);
  });
});

describe("initializePostgres — fast-path integration", () => {
  it("issues ZERO CREATE TABLE / ALTER TABLE / CREATE INDEX / CREATE TRIGGER when the marker matches", async () => {
    // Load initialize.ts lazily so CURRENT_SCHEMA_HASH is computed against
    // the real (unmocked-here) module graph.
    const { initializePostgres, CURRENT_SCHEMA_HASH } = await import("./initialize");

    const seenSql: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      // Index builds are submitted as a query config so they can carry their
      // own `query_timeout`; unwrap them or the DDL assertion below can't see
      // them.
      seenSql.push(typeof sql === "string" ? sql : (sql as { text: string }).text);
      // Every SELECT that looks like the marker read returns a matching
      // row. Anything else returns empty, so any DDL that DOES reach the
      // mock silently succeeds — the assertion is that no DDL should
      // reach it at all.
      if (sql.includes("schema_meta") && /SELECT\s+value/i.test(sql)) {
        return { rows: [{ value: CURRENT_SCHEMA_HASH }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await initializePostgres();

    const ddlPattern = /CREATE\s+TABLE(?!\s+IF\s+NOT\s+EXISTS\s+schema_meta)|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+TRIGGER|CREATE\s+OR\s+REPLACE\s+FUNCTION|DROP\s+TRIGGER|advisory_lock/i;
    const ddlCalls = seenSql.filter((sql) => ddlPattern.test(sql));
    expect(ddlCalls).toEqual([]);
  });

  it("writes the marker with CURRENT_SCHEMA_HASH after the slow path succeeds", async () => {
    // Symmetric counterpart: with no marker present, the slow path must run
    // AND end by writing the marker. Dropping the writeSchemaMarker call
    // reintroduces a startup crashloop, and this test locks the invariant in.
    const { initializePostgres, CURRENT_SCHEMA_HASH } = await import("./initialize");

    const seenCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      seenCalls.push({ sql, values });
      // No marker present — force slow path.
      if (typeof sql === "string" && sql.includes("schema_meta") && /SELECT\s+value/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      // The index-build phase only proceeds when it wins the advisory lock.
      if (typeof sql === "string" && sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      // Everything else (DDL, migration probes, advisory locks, etc.)
      // succeeds trivially so the slow path runs to completion.
      return { rows: [], rowCount: 0 };
    });

    await initializePostgres();

    const markerWrite = seenCalls.find(
      ({ sql, values }) =>
        typeof sql === "string" &&
        sql.includes("INSERT INTO schema_meta") &&
        Array.isArray(values) &&
        values[0] === CURRENT_SCHEMA_HASH
    );
    expect(markerWrite).toBeDefined();
  });

  // The marker is what lets the next boot skip the DDL entirely. Writing it
  // while an index is missing would strand that index forever: every later
  // boot fast-paths past the build with no error anywhere (#746).
  it("withholds the marker — without throwing — when an index build fails", async () => {
    const { initializePostgres } = await import("./initialize");

    const seenCalls: string[] = [];
    let attemptedIndexBuilds = 0;
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seenCalls.push(text);
      if (text.includes("schema_meta") && /SELECT\s+value/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      if (text.startsWith("CREATE INDEX CONCURRENTLY")) {
        attemptedIndexBuilds++;
        throw new Error("canceling statement due to statement timeout");
      }
      return { rows: [], rowCount: 0 };
    });

    // Resolves rather than rejecting: a slow index build must not take the
    // process down, or `restart: always` retries the same doomed build.
    await initializePostgres();

    expect(attemptedIndexBuilds).toBeGreaterThan(1);
    expect(seenCalls.filter((sql) => sql.includes("INSERT INTO schema_meta"))).toEqual([]);
  });
});
