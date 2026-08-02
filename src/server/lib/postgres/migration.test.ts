/**
 * Tests for the fast-path pre-flight in `checkSchemaAtTarget`. Under a
 * steady-state boot, this is what determines whether `initializePostgres`
 * skips its ~35+ DDL round-trips or falls through to the authoritative
 * slow path.
 *
 * Same FakePool pattern the other repository tests use — mock `pg`, run
 * the real query through the pool, control the `information_schema`
 * response per test.
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

const { checkSchemaAtTarget } = await import("./migration");
const { resetPool } = await import("./client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

// One shape of `information_schema.columns` — table_name + column_name.
const rowsFor = (
  layout: Record<string, string[]>
): Array<{ table_name: string; column_name: string }> => {
  const out: Array<{ table_name: string; column_name: string }> = [];
  for (const [table, cols] of Object.entries(layout)) {
    for (const col of cols) out.push({ table_name: table, column_name: col });
  }
  return out;
};

const stubInformationSchema = (
  layout: Record<string, string[]>
): void => {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: rowsFor(layout), rowCount: rowsFor(layout).length };
    }
    return { rows: [], rowCount: 0 };
  });
};

describe("checkSchemaAtTarget — fast-path pre-flight", () => {
  it("returns true when every expected table + column is present in the DB", async () => {
    stubInformationSchema({
      users: ["user_id", "username", "email"],
      sessions: ["session_id", "user_id"],
    });
    const result = await checkSchemaAtTarget([
      { name: "users", schema: { user_id: "UUID", username: "VARCHAR", email: "VARCHAR" } },
      { name: "sessions", schema: { session_id: "UUID", user_id: "UUID" } },
    ]);
    expect(result).toBe(true);
  });

  it("returns false when a whole expected table is missing", async () => {
    // `sessions` exists in DB, but `users` doesn't.
    stubInformationSchema({
      sessions: ["session_id", "user_id"],
    });
    const result = await checkSchemaAtTarget([
      { name: "users", schema: { user_id: "UUID" } },
      { name: "sessions", schema: { session_id: "UUID", user_id: "UUID" } },
    ]);
    expect(result).toBe(false);
  });

  it("returns false when an expected column is missing from an existing table", async () => {
    // `users` exists but `email` isn't there yet — new column deploy.
    stubInformationSchema({
      users: ["user_id", "username"],
    });
    const result = await checkSchemaAtTarget([
      {
        name: "users",
        schema: { user_id: "UUID", username: "VARCHAR", email: "VARCHAR" },
      },
    ]);
    expect(result).toBe(false);
  });

  it("returns true when the DB has EXTRA columns beyond what the schema expects", async () => {
    // A rolled-back deploy left `deprecated_col` behind. Fast path is
    // "target reached" not "no drift" — extras are ignored.
    stubInformationSchema({
      users: ["user_id", "username", "deprecated_col"],
    });
    const result = await checkSchemaAtTarget([
      { name: "users", schema: { user_id: "UUID", username: "VARCHAR" } },
    ]);
    expect(result).toBe(true);
  });

  it("returns false on any query error — falls back to the authoritative slow path", async () => {
    mockQuery.mockImplementation(async () => {
      throw new Error("simulated PG connection timeout");
    });
    const result = await checkSchemaAtTarget([
      { name: "users", schema: { user_id: "UUID" } },
    ]);
    expect(result).toBe(false);
  });

  it("returns true on an empty expectedTables list (vacuously satisfied)", async () => {
    stubInformationSchema({});
    const result = await checkSchemaAtTarget([]);
    expect(result).toBe(true);
  });

  it("uses exactly ONE information_schema round-trip regardless of expected-table count", async () => {
    stubInformationSchema({
      t1: ["c1"],
      t2: ["c1"],
      t3: ["c1"],
      t4: ["c1"],
      t5: ["c1"],
    });
    mockQuery.mockClear();
    await checkSchemaAtTarget(
      Array.from({ length: 5 }, (_, i) => ({
        name: `t${i + 1}`,
        schema: { c1: "TEXT" },
      }))
    );
    // Count calls that hit information_schema.columns — must be exactly 1.
    const infoSchemaCalls = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("information_schema.columns")
    );
    expect(infoSchemaCalls.length).toBe(1);
  });
});
