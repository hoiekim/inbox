import { Pool, PoolConfig, types } from "pg";

const {
  POSTGRES_HOST: host = "localhost",
  POSTGRES_PORT: port = "5432",
  POSTGRES_USER: user = "postgres",
  POSTGRES_PASSWORD: password,
  POSTGRES_DATABASE: database = "inbox",
} = process.env;

const timestampToIso = (s: string) => {
  return s.replace(
    /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2})(:\d{2})?$/,
    (_, d, t, m) => `${d}T${t}${m || ":00"}`,
  );
};

const config: PoolConfig = {
  host,
  port: parseInt(port, 10),
  user,
  password,
  database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  types: {
    getTypeParser(id, format) {
      if (id === types.builtins.NUMERIC) return parseFloat;
      if (id === types.builtins.INT8) return parseFloat;
      if (id === types.builtins.DATE) return (s: string) => s;
      if (id === types.builtins.TIMESTAMPTZ) return timestampToIso;
      return types.getTypeParser(id, format);
    },
  },
};

// Lazy pool: the Proxy defers `new Pool(config)` to first property
// access. `Pool` here is a LIVE ESM binding to `pg.Pool` — bun's
// `mock.module("pg", () => ({ Pool: FakePool, … }))` from a test file
// re-points it, so the first method call during that file's tests
// instantiates the test's FakePool.
//
// `resetPool()` clears the cached instance so the NEXT first-access
// rebuilds against whatever `Pool` resolves to at that moment. Tests
// call this from `afterAll(restoreLeaves)` (`scripts/test-helpers.ts`,
// landing alongside the test infra in #557 step 1) so file B's run
// doesn't inherit file A's FakePool. Production never calls
// `resetPool()` — the cached real Pool stays for the process lifetime.
//
// The traps below all forward to `_pool`. `set`/`deleteProperty`/`has`
// are required (not just `get`) because pg's own Pool methods do
// `this.ending = true`, `this._clients = filtered`, etc. — the default
// Proxy `set` would write to the empty target, leaving `_pool` stale.
let _pool: Pool | null = null;
const getPool = (): Pool => {
  if (!_pool) _pool = new Pool(config);
  return _pool;
};
export const resetPool = (): void => {
  _pool = null;
};
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    return Reflect.get(getPool(), prop, getPool());
  },
  set(_target, prop, value) {
    return Reflect.set(getPool(), prop, value, getPool());
  },
  has(_target, prop) {
    return Reflect.has(getPool(), prop);
  },
  deleteProperty(_target, prop) {
    return Reflect.deleteProperty(getPool(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getPool());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getPool(), prop);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getPool());
  },
});

// Log unexpected pool-level errors so they appear in server logs and are not silently swallowed.
// Without this, a background idle client error would surface as an unhandled rejection.
pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err);
});

// Graceful shutdown is handled centrally in start.ts (SIGTERM/SIGINT → shutdown()).
// Do not register pool.end() handlers here — duplicate handlers cause a race condition
// where pool.end() is called twice: once from client.ts and once from shutdown(),
// resulting in "Cannot use a pool after calling end on the pool" errors during startup.
