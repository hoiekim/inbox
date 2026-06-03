import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";

// Capture real pg before mocking so we can restore at end-of-file.
const realPg = { ...(await import("pg")) };

const ctorCalls = mock(() => {});

class FakePool {
  ending = false;
  _clients: string[] = ["c1", "c2", "c3"];
  config: unknown;
  // EventEmitter-style mutation field — set trap regression test.
  listeners: Array<(err: Error) => void> = [];
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
  on(_event: string, handler: (err: Error) => void) {
    this.listeners.push(handler);
  }
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { pool, resetPool } = await import("./client");

afterAll(() => {
  // Restore pg so subsequent test files don't see FakePool.
  mock.module("pg", () => realPg);
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

  test("assignments forward to the underlying Pool (regression: pg.Pool methods do `this.ending = true`)", async () => {
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
