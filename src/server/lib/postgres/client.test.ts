import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const ctorCalls = mock(() => {});

class FakePool {
  ending = false;
  _clients: string[] = ["c1", "c2", "c3"];
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
    ctorCalls();
  }
  end() {
    this.ending = true;
    this._clients = this._clients.filter((c) => c !== "c2");
    return Promise.resolve();
  }
  query() {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  connect() {
    return Promise.resolve({ query: () => {}, release: () => {} });
  }
}

mock.module("server/lib/postgres/pool", () => ({ Pool: FakePool }));

const { pool, resetPool } = await import("./client");

afterAll(() => {
  // Restore the driver so subsequent test files don't see FakePool.
  restoreLeaves();
  resetPool();
});

describe("lazy pool Proxy", () => {
  beforeAll(() => {
    resetPool();
    ctorCalls.mockClear();
  });

  test("first property access instantiates exactly one Pool", () => {
    resetPool();
    ctorCalls.mockClear();
    void pool.ending;
    void pool.connect;
    void pool.query;
    expect(ctorCalls).toHaveBeenCalledTimes(1);
  });

  test("assignments forward to the underlying Pool (methods that do `this.ending = true`)", async () => {
    resetPool();
    expect(pool.ending).toBe(false);
    await pool.end();
    expect(pool.ending).toBe(true);
  });

  test("methods that mutate via `this.prop = filtered(this.prop)` land on the real Pool", async () => {
    resetPool();
    expect(pool._clients).toEqual(["c1", "c2", "c3"]);
    await pool.end();
    expect(pool._clients).toEqual(["c1", "c3"]);
  });

  test("`in` operator and key enumeration forward to the underlying Pool", () => {
    resetPool();
    expect("ending" in pool).toBe(true);
    expect("nonexistent" in pool).toBe(false);
    expect(Object.keys(pool)).toContain("ending");
  });

  test("prototype chain forwards — instanceof works against the wrapped class", () => {
    resetPool();
    void pool.ending;
    expect(Object.getPrototypeOf(pool)).toBe(FakePool.prototype);
  });

  test("resetPool drops the cached instance so the next access rebuilds", () => {
    resetPool();
    void pool.ending;
    const before = ctorCalls.mock.calls.length;
    resetPool();
    void pool.ending;
    expect(ctorCalls.mock.calls.length).toBe(before + 1);
  });
});

describe("pool config", () => {
  test("passes both a server-side (statement_timeout) and client-side (query_timeout) cap", () => {
    resetPool();
    // Force construction so FakePool captures the config we handed to `new Pool()`.
    void pool.ending;
    const cfg = (pool as unknown as { config: Record<string, unknown> }).config;
    expect(cfg.statementTimeoutMillis).toBe(30_000);
    expect(cfg.queryTimeoutMillis).toBe(30_000);
  });

  test("keeps the standing connection count modest", () => {
    resetPool();
    void pool.ending;
    const cfg = (pool as unknown as { config: Record<string, unknown> }).config;
    // Every connection opens on the first query and stays until idle, so this
    // is what the database carries for one app instance.
    expect(cfg.max).toBe(10);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
  });
});
