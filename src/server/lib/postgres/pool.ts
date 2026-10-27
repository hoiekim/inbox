import { SQL } from "bun";

// A row is untyped until a caller names its shape with `query<T>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedRow = any;

export type QueryResultRow = Record<string, UntypedRow>;

export interface QueryResult<R = UntypedRow> {
  rows: R[];
  /**
   * Rows returned by a SELECT, or affected by an INSERT/UPDATE/DELETE. Null
   * for a statement that reports no count, such as DDL or SET.
   */
  rowCount: number | null;
  command: string;
}

export interface QueryConfig {
  text: string;
  values?: unknown[];
  /** Client-side bound for this statement, overriding the pool default. */
  query_timeout?: number;
}

export interface PoolClient {
  query<R = UntypedRow>(
    textOrConfig: string | QueryConfig,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
  /** Pass `true` to close the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
}

export interface PoolOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  /** Server-side `statement_timeout`, set on every connection at startup; 0 disables it. */
  statementTimeoutMillis: number;
  /** Client-side backstop that rejects a statement the server never answers; 0 disables it. */
  queryTimeoutMillis: number;
}

/**
 * A failed statement. `code` is the SQLSTATE (for example `23505` on a unique
 * violation), the field every caller branches on.
 */
export class DatabaseError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;

  constructor(cause: unknown) {
    const source = (cause ?? {}) as Record<string, unknown>;
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DatabaseError";
    const text = (key: string) => (typeof source[key] === "string" ? source[key] : undefined);
    this.code = text("errno") ?? text("code");
    this.detail = text("detail");
    this.constraint = text("constraint");
    this.table = text("table");
    this.column = text("column");
  }
}

const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;
const TIMESTAMPTZ = 1184;

/**
 * Commands whose completion tag carries a row count. Every other statement
 * reports a null `rowCount`.
 */
const COUNTED_COMMANDS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "COPY",
  "FETCH",
  "MOVE",
]);

type Converter = (value: unknown) => unknown;

const toNumber: Converter = (value) => (typeof value === "string" ? parseFloat(value) : value);

const toDateString: Converter = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value;

const toTimestampString: Converter = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value;

/**
 * Result-shape conversions keyed by column type. Counts and BIGINT columns are
 * numbers, and timestamps are ISO strings rather than `Date`s, throughout the
 * code that reads rows; the driver returns strings and `Date`s for these.
 */
const CONVERTERS: Record<number, Converter> = {
  [INT8]: toNumber,
  [NUMERIC]: toNumber,
  [DATE]: toDateString,
  [TIMESTAMPTZ]: toTimestampString,
};

interface DriverResult extends Array<QueryResultRow> {
  command?: string;
  count?: number | null;
  columns?: { name: string; type: number }[];
}

const toQueryResult = <R>(raw: DriverResult | DriverResult[]): QueryResult<R> => {
  // A multi-statement simple query yields one result per statement; the last
  // one is what the batch reports.
  const result = (typeof (raw as DriverResult).command === "string"
    ? raw
    : (raw as DriverResult[])[raw.length - 1] ?? []) as DriverResult;

  const conversions = (result.columns ?? []).flatMap(({ name, type }) =>
    CONVERTERS[type] ? [[name, CONVERTERS[type]] as const] : []
  );
  const rows = Array.from(result);
  if (conversions.length) {
    for (const row of rows) {
      for (const [name, convert] of conversions) row[name] = convert(row[name]);
    }
  }

  const command = result.command ?? "";
  const rowCount = COUNTED_COMMANDS.has(command) ? (result.count ?? rows.length) : null;
  return { rows: rows as R[], rowCount, command };
};

/** An array as a Postgres array literal, such as `{"a","b c",NULL}`. */
const arrayLiteral = (values: unknown[]): string =>
  `{${values
    .map((value) => {
      if (value === null || value === undefined) return "NULL";
      if (Array.isArray(value)) return arrayLiteral(value);
      if (Buffer.isBuffer(value)) return `"\\\\x${value.toString("hex")}"`;
      const text = String(toParam(value));
      return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(",")}}`;

/**
 * Binds every parameter as text (or bytes), leaving its type to the statement:
 * the driver would otherwise type a number as integer and a boolean as bool,
 * and a statement such as `WHERE text_col = $1` would stop matching a number.
 */
const toParam = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

type Executor = Pick<SQL, "unsafe">;

const run = async <R>(
  executor: Executor,
  textOrConfig: string | QueryConfig,
  values: unknown[] | undefined,
  defaultTimeoutMillis: number
): Promise<QueryResult<R>> => {
  const config = typeof textOrConfig === "string" ? { text: textOrConfig, values } : textOrConfig;
  const timeoutMillis = config.query_timeout || defaultTimeoutMillis;
  const statement = config.values?.length
    ? executor.unsafe(config.text, config.values.map(toParam) as never[])
    : executor.unsafe(config.text);

  const timeoutError = new Error("Query read timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    if (!timeoutMillis) return;
    timer = setTimeout(() => {
      statement.cancel();
      reject(timeoutError);
    }, timeoutMillis);
  });

  try {
    const raw = await Promise.race([statement, timeout]);
    return toQueryResult<R>(raw as DriverResult | DriverResult[]);
  } catch (error) {
    throw error === timeoutError ? error : new DatabaseError(error);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Connection pool over `Bun.SQL`, exposing the `query` / `connect` / `end`
 * surface the repositories are written against.
 *
 * Statements run unprepared: a named statement per distinct SQL text per
 * connection grows backend memory without bound for the size-varying SQL this
 * app issues (multi-row inserts, `IN ($1..$n)` lists).
 *
 * @example
 * const pool = new Pool(options);
 * const { rows } = await pool.query<{ id: string }>("SELECT id FROM t WHERE x = $1", [x]);
 */
export class Pool {
  private readonly sql: SQL;
  private readonly queryTimeoutMillis: number;

  constructor(options: PoolOptions) {
    this.queryTimeoutMillis = options.queryTimeoutMillis;
    this.sql = new SQL({
      hostname: options.host,
      port: options.port,
      username: options.user,
      password: options.password,
      database: options.database,
      max: options.max,
      idleTimeout: Math.ceil(options.idleTimeoutMillis / 1000),
      connectionTimeout: Math.ceil(options.connectionTimeoutMillis / 1000),
      prepare: false,
      connection: { statement_timeout: String(options.statementTimeoutMillis) },
      onclose: (error) => {
        // Server-initiated closes (a restart, a terminated backend) carry a
        // SQLSTATE; idle-timeout and shutdown closes do not.
        if (error && "errno" in error) console.error("Database connection lost:", error);
      },
    });
  }

  query<R = UntypedRow>(
    textOrConfig: string | QueryConfig,
    values?: unknown[]
  ): Promise<QueryResult<R>> {
    return run<R>(this.sql, textOrConfig, values, this.queryTimeoutMillis);
  }

  /**
   * Checks out one connection for statements that must share a session — a
   * transaction, an advisory lock, a session-level `SET`. Always `release()`.
   */
  async connect(): Promise<PoolClient> {
    const reserved = await this.sql.reserve();
    const queryTimeoutMillis = this.queryTimeoutMillis;
    return {
      query: <R = UntypedRow>(textOrConfig: string | QueryConfig, values?: unknown[]) =>
        run<R>(reserved, textOrConfig, values, queryTimeoutMillis),
      release: (destroy?: boolean) => {
        if (destroy) void reserved.close();
        else reserved.release();
      },
    };
  }

  /** Closes every connection once in-flight statements settle. */
  end(): Promise<void> {
    return this.sql.close();
  }
}
