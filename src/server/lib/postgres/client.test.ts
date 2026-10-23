import { describe, test, expect, mock, spyOn, beforeAll, afterAll } from "bun:test";
import { EventEmitter } from "events";

// Capture real pg before mocking so we can restore at end-of-file.
const realPg = { ...(await import("pg")) };

const ctorCalls = mock(() => {});

class FakePool {
  ending = false;
  _clients: string[] = ["c1", "c2", "c3"];
  config: unknown;
  // EventEmitter-style mutation field — set trap regression test.
  listeners: Record<string, Array<(arg: unknown) => void>> = {};
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
  on(event: string, handler: (arg: unknown) => void) {
    (this.listeners[event] ??= []).push(handler);
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

describe("pool config", () => {
  test("passes both a server-side (statement_timeout) and client-side (query_timeout) cap", () => {
    resetPool();
    // Force construction so FakePool captures the config we handed to `new Pool()`.
    void pool.ending;
    const cfg = (pool as unknown as { config: Record<string, unknown> }).config;
    expect(cfg.statement_timeout).toBe(30_000);
    expect(cfg.query_timeout).toBe(30_000);
  });
});

describe("dropped connections", () => {
  const dropped = Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
  const builtPool = () => {
    resetPool();
    void pool.ending;
    return pool as unknown as FakePool;
  };

  test("a checked-out client's dropped connection is logged and does not throw", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = new EventEmitter();
      for (const onConnect of builtPool().listeners.connect ?? []) onConnect(client);
      expect(() => client.emit("error", dropped)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[1]).toBe(dropped);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("an idle client's error re-emitted on the pool is not logged a second time", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const onError = builtPool().listeners.error ?? [];
      expect(onError).toHaveLength(1);
      onError[0]?.(dropped);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a rebuilt pool gets the listeners too", () => {
    builtPool();
    resetPool();
    expect(builtPool().listeners.connect).toHaveLength(1);
  });
});
