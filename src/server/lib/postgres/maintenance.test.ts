/**
 * The invalid-leftover sweep is the load-bearing half of the concurrent
 * index build: a `CREATE INDEX CONCURRENTLY` that fails leaves the index in
 * the catalog marked invalid, and `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
 * then matches it by name and no-ops. Without the sweep the retry can never
 * succeed, and the failure mode is a boot log that looks clean forever while
 * the index stays unusable.
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

/** The shape `runLongQuery` passes to `client.query`. */
type TimedConfig = { text: string; query_timeout?: number };

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
    // Checked before the canned responses so `fail` can target the probe too.
    if (fail.some((needle) => text.includes(needle))) {
      throw new Error(`boom: ${text}`);
    }
    if (text.includes("pg_try_advisory_lock")) {
      return { rows: [{ locked }], rowCount: 1 };
    }
    if (text.includes("pg_backend_pid")) {
      return { rows: [{ pid: 4242 }], rowCount: 1 };
    }
    if (text.includes("FROM pg_index")) {
      return { rows: invalid.map((relname) => ({ relname })), rowCount: invalid.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return seen;
};

describe("runBootMaintenance — invalid-leftover sweep", () => {
  it("drops an invalid leftover before rebuilding it", async () => {
    const seen = arrange({ invalid: ["idx_beta"] });
    expect(await runBootMaintenance(work())).toBe("complete");

    const drop = seen.findIndex((s) => s.startsWith("DROP INDEX CONCURRENTLY"));
    const rebuild = seen.indexOf(INDEXES[1].sql);
    expect(seen[drop]).toBe("DROP INDEX CONCURRENTLY IF EXISTS idx_beta");
    expect(drop).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(drop);
  });

  it("drops nothing when no index is invalid", async () => {
    const seen = arrange();
    expect(await runBootMaintenance(work())).toBe("complete");
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
    expect(await runBootMaintenance(work())).toBe("incomplete");
    expect(seen).not.toContain(INDEXES[1].sql);
    // The unaffected index and the trailing statements still run.
    expect(seen).toContain(INDEXES[0].sql);
    expect(seen).toContain(STATEMENTS[0].sql);
  });

  // A failed probe means we don't know which builds a leftover is shadowing,
  // and a shadowed `CREATE INDEX CONCURRENTLY IF NOT EXISTS` no-ops silently.
  // Claiming completeness there is what writes the marker over a stranded
  // index — so the builds are still attempted, but the phase reports
  // incomplete and the next boot retries.
  it("attempts every build when the probe fails, but does not claim completeness", async () => {
    const seen = arrange({ fail: ["FROM pg_index"] });
    expect(await runBootMaintenance(work())).toBe("incomplete");
    expect(seen).toContain(INDEXES[0].sql);
    expect(seen).toContain(INDEXES[1].sql);
  });
});

describe("runBootMaintenance — session and locking", () => {
  // "skipped", not "incomplete": the instance holding the lock is doing the
  // work. Every rolling deploy produces a loser, and paging for each one
  // trains the alarm to be ignored.
  it("runs nothing and reports skipped when another instance holds the lock", async () => {
    const seen = arrange({ locked: false });
    expect(await runBootMaintenance(work())).toBe("skipped");
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
    expect(await runBootMaintenance(work())).toBe("incomplete");
    expect(seen.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("does not release a lock it never acquired", async () => {
    const seen = arrange({ locked: false });
    await runBootMaintenance(work());
    expect(seen.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);
  });

  it("reports failure without throwing when every statement fails", async () => {
    arrange({ fail: ["CREATE INDEX", "UPDATE t"] });
    expect(await runBootMaintenance(work())).toBe("incomplete");
  });

  // pg reads `config.query_timeout || connectionParameters.query_timeout`, so a
  // per-query 0 falls back to the pool's 30s: every build and the reindex would
  // be killed client-side at 30s with the session's 10-minute budget, set one
  // line later, still in place and the suite still green.
  it("gives every long statement a client read timeout above the pool default", async () => {
    const configs: TimedConfig[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      if (typeof sql !== "string") configs.push(sql as TimedConfig);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
      if (text.includes("FROM pg_index")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await runBootMaintenance(work());

    expect(configs.map((c) => c.text)).toContain(INDEXES[0].sql);
    const unbudgeted = configs.filter((c) => !((c.query_timeout ?? 0) > 30_000));
    expect(unbudgeted.map((c) => c.text)).toEqual([]);
  });
});

// A statement that rewrites the whole table locks every row it touches until
// it commits, so the reindex is written to affect a bounded slice per
// execution — which only finishes the job if the caller keeps issuing it.
describe("runBootMaintenance — draining statements", () => {
  const drainWork = (drain: boolean) => ({
    indexes: [],
    statements: [{ ...STATEMENTS[0], drain }],
  });

  /** Reports rows rewritten for the first `chunks` executions, then none. */
  const arrangeChunks = (chunks: number) => {
    let issued = 0;
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
      if (text.includes("FROM pg_index")) return { rows: [], rowCount: 0 };
      if (text === STATEMENTS[0].sql) {
        issued++;
        return { rows: [], rowCount: issued <= chunks ? 1000 : 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    return () => issued;
  };

  it("re-issues a draining statement until it rewrites no rows", async () => {
    const issued = arrangeChunks(3);
    expect(await runBootMaintenance(drainWork(true))).toBe("complete");
    expect(issued()).toBe(4);
  });

  // Index builds report no rows and must not be re-issued on that basis.
  it("issues a non-draining statement exactly once, whatever it reports", async () => {
    const issued = arrangeChunks(3);
    expect(await runBootMaintenance(drainWork(false))).toBe("complete");
    expect(issued()).toBe(1);
  });

  // Shutdown lands between chunks, so nothing throws and the loop's own
  // per-statement check never runs again — the drain has to watch the signal.
  it("stops draining, and reports skipped, once aborted", async () => {
    const abort = new AbortController();
    let issued = 0;
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
      if (text.includes("FROM pg_index")) return { rows: [], rowCount: 0 };
      if (text === STATEMENTS[0].sql) {
        issued++;
        abort.abort();
        return { rows: [], rowCount: 1000 };
      }
      return { rows: [], rowCount: 0 };
    });

    expect(await runBootMaintenance(drainWork(true), abort.signal)).toBe("skipped");
    expect(issued).toBe(1);
  });
});

// `pool.end()` waits for every checked-out client to be released, so an
// in-flight build would hold graceful shutdown open until its budget expired
// and the container was SIGKILLed instead.
describe("runBootMaintenance — shutdown cancellation", () => {
  it("cancels the in-flight backend and stops before the remaining statements", async () => {
    const abort = new AbortController();
    const cancelArgs: unknown[][] = [];
    const seen: string[] = [];
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seen.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
      if (text.includes("FROM pg_index")) return { rows: [], rowCount: 0 };
      if (text.includes("pg_cancel_backend")) cancelArgs.push(values ?? []);
      // Shutdown arrives while the first index is building.
      if (text === INDEXES[0].sql) abort.abort();
      return { rows: [], rowCount: 0 };
    });

    expect(await runBootMaintenance(work(), abort.signal)).toBe("skipped");
    // The running statement is cancelled from another session, by pid.
    expect(cancelArgs).toEqual([[4242]]);
    // The first build was already in flight; the rest were never issued.
    expect(seen).toContain(INDEXES[0].sql);
    expect(seen).not.toContain(INDEXES[1].sql);
    expect(seen).not.toContain(STATEMENTS[0].sql);
    // The lock is still handed back, or the next boot's try-lock fails.
    expect(seen.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });

  // The cancelled statement throws, and if it is the last one the loop's own
  // abort check never runs again. Letting that surface as "incomplete" would
  // page on every graceful stop.
  it("reports skipped, not incomplete, when the cancelled statement is the last one", async () => {
    const abort = new AbortController();
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
      if (text.includes("FROM pg_index")) return { rows: [], rowCount: 0 };
      if (text === STATEMENTS[0].sql) {
        abort.abort();
        throw new Error("canceling statement due to user request");
      }
      return { rows: [], rowCount: 0 };
    });

    expect(await runBootMaintenance(work(), abort.signal)).toBe("skipped");
  });

  // `addEventListener` does not fire on an already-aborted signal, so an abort
  // landing between the entry check and the listener registration — during
  // connect, the try-lock, or the pid read — would be dropped, and the phase
  // would run every statement to completion after SIGTERM.
  it("honours an abort that lands before the listener is registered", async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seen.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) {
        abort.abort();
        return { rows: [{ pid: 4242 }], rowCount: 1 };
      }
      if (text.includes("FROM pg_index")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    expect(await runBootMaintenance(work(), abort.signal)).toBe("skipped");
    // It stops before the sweep, not just before the builds: the sweep issues
    // `DROP INDEX CONCURRENTLY`, which is itself a long-budget statement.
    expect(seen.filter((s) => s.includes("FROM pg_index"))).toEqual([]);
    expect(seen.filter((s) => s.startsWith("SET statement_timeout"))).toEqual([]);
    expect(seen.filter((s) => s.startsWith("CREATE INDEX"))).toEqual([]);
    expect(seen).not.toContain(STATEMENTS[0].sql);
    expect(seen.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });

  // A `DROP INDEX CONCURRENTLY` waits out concurrent lockers on the same long
  // budget, so the sweep loop has to watch the signal too.
  it("stops issuing DROPs once aborted", async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
      seen.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
      if (text.includes("FROM pg_index")) {
        return { rows: [{ relname: "idx_alpha" }, { relname: "idx_beta" }], rowCount: 2 };
      }
      // Shutdown arrives while the first DROP is running.
      if (text.startsWith("DROP INDEX")) abort.abort();
      return { rows: [], rowCount: 0 };
    });

    expect(await runBootMaintenance(work(), abort.signal)).toBe("skipped");
    expect(seen.filter((s) => s.startsWith("DROP INDEX"))).toEqual([
      "DROP INDEX CONCURRENTLY IF EXISTS idx_alpha",
    ]);
    expect(seen.filter((s) => s.startsWith("CREATE INDEX"))).toEqual([]);
  });

  it("does not connect at all when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const seen = arrange();
    expect(await runBootMaintenance(work(), abort.signal)).toBe("skipped");
    expect(seen).toEqual([]);
  });

  it("leaves no abort listener behind after a normal run", async () => {
    const abort = new AbortController();
    arrange();
    expect(await runBootMaintenance(work(), abort.signal)).toBe("complete");

    // A leaked listener would cancel a backend pid that has since been reused.
    const seen = arrange();
    abort.abort();
    expect(seen.filter((s) => s.includes("pg_cancel_backend"))).toEqual([]);
  });
});
