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
import { describe, it, expect, mock, spyOn, beforeAll, afterAll } from "bun:test";
import * as alarm from "../alarm";
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
    expect(calls[1][1]).toEqual(["schema_hash", "MYHASH"]);
  });

  // The two halves of the boot DDL are gated separately: the fatal schema work
  // and the non-fatal row-scaled work. Sharing one key would send every boot
  // back through the throwing DDL block for as long as an index can't build.
  it("writes the row-scaled work under its own key", async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      calls.push([sql, values]);
      return { rows: [], rowCount: 0 };
    });
    await writeSchemaMarker("MYHASH", "maintenance_hash");
    expect(calls[1][1]).toEqual(["maintenance_hash", "MYHASH"]);
  });

  it("reads back the key it was asked for", async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      calls.push([sql, values]);
      return { rows: [{ value: "MYHASH" }], rowCount: 1 };
    });
    expect(await checkSchemaAtTarget("MYHASH", "maintenance_hash")).toBe(true);
    expect(calls[0][1]).toEqual(["maintenance_hash"]);
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

  // The schema half writes its own marker as soon as its own DDL succeeds, and
  // must NOT wait on the row-scaled half — gating it on maintenance would send
  // every boot back through this throwing block for as long as an index can't
  // build, which is the same crashloop entered by a different door.
  it("writes the schema marker without waiting on boot maintenance", async () => {
    const { initializePostgres, CURRENT_SCHEMA_HASH } = await import("./initialize");

    const seenCalls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seenCalls.push({ sql: text, values });
      return { rows: [], rowCount: 0 };
    });

    await initializePostgres();

    const markerWrites = seenCalls.filter(({ sql }) => sql.includes("INSERT INTO schema_meta"));
    expect(markerWrites.map(({ values }) => values)).toEqual([
      ["schema_hash", CURRENT_SCHEMA_HASH],
    ]);
    // It builds no index — that is the maintenance phase's job.
    expect(seenCalls.filter(({ sql }) => sql.startsWith("CREATE INDEX"))).toEqual([]);
  });
});

describe("bootMaintenance — marker gating", () => {
  const collect = (
    onStatement: (text: string) => void = () => {}
  ): Array<{ sql: string; values: unknown[] | undefined }> => {
    const seen: Array<{ sql: string; values: unknown[] | undefined }> = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seen.push({ sql: text, values });
      // The phase only proceeds when it wins the advisory lock.
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      // No maintenance marker present, so the phase runs rather than skipping.
      if (text.includes("SELECT value FROM schema_meta")) {
        return { rows: [], rowCount: 0 };
      }
      onStatement(text);
      return { rows: [], rowCount: 0 };
    });
    return seen;
  };

  it("writes the maintenance marker once every statement lands", async () => {
    const { bootMaintenance, CURRENT_SCHEMA_HASH } = await import("./initialize");

    const seen = collect();
    await bootMaintenance();

    const markerWrites = seen.filter(({ sql }) => sql.includes("INSERT INTO schema_meta"));
    // Under its own key — never the schema one, which gates the fatal DDL.
    expect(markerWrites.map(({ values }) => values)).toEqual([
      ["maintenance_hash", CURRENT_SCHEMA_HASH],
    ]);
    // And it reads back under that key too: reading `schema_hash` here would
    // match the marker `initializePostgres` just wrote and skip the whole
    // phase after every DDL deploy — no index built, no reindex run, and the
    // marker never written is never missed.
    const markerRead = seen.find(({ sql }) => sql.includes("SELECT value FROM schema_meta"));
    expect(markerRead?.values).toEqual(["maintenance_hash"]);
  });

  // Degrading instead of exiting removed the page `handleStartupFailure` used
  // to produce, so the replacement alarm has to fire on exactly the outcome it
  // replaces — and on nothing else. Both halves were unguarded until now.
  describe("alarm mapping", () => {
    const runWith = async (onStatement: (text: string) => void) => {
      const { bootMaintenance } = await import("./initialize");
      const sendSpy = spyOn(alarm, "sendAlarm").mockResolvedValue(undefined);
      collect(onStatement);
      await bootMaintenance();
      const calls = sendSpy.mock.calls.map(([title]) => title);
      sendSpy.mockRestore();
      return calls;
    };

    it("pages when a statement is genuinely outstanding", async () => {
      const calls = await runWith((text) => {
        if (text.startsWith("CREATE INDEX CONCURRENTLY")) throw new Error("too slow");
      });
      expect(calls).toEqual(["Boot Maintenance Incomplete"]);
    });

    it("stays quiet on a clean run", async () => {
      expect(await runWith(() => {})).toEqual([]);
    });

    // Every rolling deploy produces one instance that loses the lock. Paging
    // for it trains the alarm to be ignored.
    it("stays quiet when another instance holds the lock", async () => {
      const { bootMaintenance } = await import("./initialize");
      const sendSpy = spyOn(alarm, "sendAlarm").mockResolvedValue(undefined);
      mockQuery.mockImplementation(async (sql: string) => {
        const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
        if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      await bootMaintenance();
      expect(sendSpy.mock.calls).toEqual([]);
      sendSpy.mockRestore();
    });
  });

  // Without its own marker every restart would re-run a full-table tsvector
  // recompute that changes nothing.
  it("skips the whole phase when the maintenance marker is already at target", async () => {
    const { bootMaintenance, CURRENT_SCHEMA_HASH } = await import("./initialize");

    const seen: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seen.push(text);
      if (text.includes("SELECT value FROM schema_meta")) {
        return { rows: [{ value: CURRENT_SCHEMA_HASH }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await bootMaintenance();

    expect(seen.filter((sql) => sql.startsWith("CREATE INDEX"))).toEqual([]);
    expect(seen.filter((sql) => sql.includes("SET search_vector"))).toEqual([]);
    expect(seen.filter((sql) => sql.includes("advisory_lock"))).toEqual([]);
  });

  // The marker is what lets the next boot skip the DDL entirely. Writing it
  // while an index is missing would strand that index forever: every later
  // boot fast-paths past the build with no error anywhere.
  it("withholds the marker — without throwing — when an index build fails", async () => {
    const { bootMaintenance } = await import("./initialize");

    let attemptedIndexBuilds = 0;
    const seen = collect((text) => {
      if (text.startsWith("CREATE INDEX CONCURRENTLY")) {
        attemptedIndexBuilds++;
        throw new Error("canceling statement due to statement timeout");
      }
    });

    // Resolves rather than rejecting: a slow index build must not take the
    // process down, or `restart: always` retries the same doomed build.
    await bootMaintenance();

    // Every index is attempted, not just the first — one slow build must not
    // cost the rest of them.
    expect(attemptedIndexBuilds).toBeGreaterThan(1);
    expect(seen.filter(({ sql }) => sql.includes("INSERT INTO schema_meta"))).toEqual([]);
  });

  // The reindex is a full-table UPDATE whose 30s wall arrives ~12x sooner than
  // any index build's, so it gets the same non-fatal, marker-gating treatment.
  it("withholds the marker when only the search-vector reindex fails", async () => {
    const { bootMaintenance } = await import("./initialize");

    let attemptedReindexes = 0;
    const seen = collect((text) => {
      if (text.includes("SET search_vector")) {
        attemptedReindexes++;
        throw new Error("canceling statement due to statement timeout");
      }
    });

    await bootMaintenance();

    expect(attemptedReindexes).toBe(1);
    expect(seen.filter(({ sql }) => sql.includes("INSERT INTO schema_meta"))).toEqual([]);
    // The indexes are not collateral damage — they still get built.
    expect(
      seen.filter(({ sql }) => sql.startsWith("CREATE INDEX CONCURRENTLY")).length
    ).toBeGreaterThan(1);
  });
});
