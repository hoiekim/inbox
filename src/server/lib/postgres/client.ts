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
  statement_timeout: 30_000,
  // Client-side backstop: fires if statement_timeout can't — e.g. the TCP
  // connection is silently wedged and the server never delivers the abort.
  query_timeout: 30_000,
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

/**
 * Keeps a dropped connection (e.g. Postgres restarting) from becoming an
 * uncaught exception. pg emits it on the client, and pg-pool detaches its own
 * listener while a client is checked out, so every client gets one here. The
 * dead client's next query rejects and the pool replaces it.
 */
const logDroppedConnections = (target: Pool): void => {
  target.on("connect", (client) => {
    client.on("error", (err) => {
      console.error("Database connection lost:", err);
    });
  });
  // pg-pool re-emits an idle client's error here, after the client listener logged it.
  target.on("error", () => {});
};

let _pool: Pool | null = null;
const getPool = (): Pool => {
  if (!_pool) {
    _pool = new Pool(config);
    logDroppedConnections(_pool);
  }
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

// Graceful shutdown is handled centrally in start.ts (SIGTERM/SIGINT → shutdown()).
// Do not register pool.end() handlers here — duplicate handlers cause a race condition
// where pool.end() is called twice: once from client.ts and once from shutdown(),
// resulting in "Cannot use a pool after calling end on the pool" errors during startup.
