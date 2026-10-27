import { describe, it, expect, afterAll, spyOn } from "bun:test";

// Other suites mock this module process-wide; the preload's snapshot is the
// real driver whatever ran before this file.
const { Pool, DatabaseError } = ((globalThis as Record<string, unknown>).__REAL_POOL ??
  (await import("./pool"))) as typeof import("./pool");

describe("DatabaseError", () => {
  it("carries the SQLSTATE as `code`, the field callers branch on", () => {
    const error = new DatabaseError(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23505",
        constraint: "users_pkey",
        detail: "Key (id)=(1) already exists.",
      })
    );
    expect(error.code).toBe("23505");
    expect(error.constraint).toBe("users_pkey");
    expect(error.detail).toBe("Key (id)=(1) already exists.");
    expect(error.message).toBe("duplicate key value violates unique constraint");
  });

  it("keeps the driver's own code when there is no SQLSTATE", () => {
    const error = new DatabaseError(
      Object.assign(new Error("Connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" })
    );
    expect(error.code).toBe("ERR_POSTGRES_CONNECTION_CLOSED");
  });
});

const PG_URL = process.env.INBOX_TEST_PG_URL;

// A plain `if` rather than `describe.skipIf`, so no pool is ever built without
// a database to point it at.
if (PG_URL) describe("Pool against a real Postgres", () => {
  const url = new URL(PG_URL);
  const options = {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: url.pathname.slice(1),
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statementTimeoutMillis: 30_000,
    queryTimeoutMillis: 30_000,
  };
  const pool = new Pool(options);
  const table = `pool_probe_${process.pid}`;

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  it("reports rowCount the way the repositories read it", async () => {
    expect((await pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, n bigint)`)).rowCount).toBeNull();
    expect((await pool.query(`INSERT INTO ${table} VALUES ($1, $2), ($3, $4)`, [1, 10, 2, 20])).rowCount).toBe(2);
    expect(
      (await pool.query(`INSERT INTO ${table} VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`, [1, 1]))
        .rowCount
    ).toBe(0);
    expect((await pool.query(`UPDATE ${table} SET n = n + 1`)).rowCount).toBe(2);
    expect((await pool.query(`UPDATE ${table} SET n = 0 WHERE id = $1`, [99])).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(2);
    expect((await pool.query(`DELETE FROM ${table} WHERE id = $1`, [2])).rowCount).toBe(1);
    expect((await pool.query("SET LOCAL statement_timeout = 1000")).rowCount).toBeNull();
  });

  it("returns counts and BIGINTs as numbers and timestamps as ISO strings", async () => {
    const { rows } = await pool.query(
      `SELECT count(*) AS c, 12345678901::bigint AS big, 1.5::numeric AS num, 3 AS i,
              '2026-01-02 03:04:05.678+00'::timestamptz AS ts, '2026-01-02'::date AS d,
              '{"a":[1,2]}'::jsonb AS j, ARRAY['x','y'] AS arr, NULL::text AS nothing, true AS b`
    );
    expect(rows[0]).toEqual({
      c: 1,
      big: 12345678901,
      num: 1.5,
      i: 3,
      ts: "2026-01-02T03:04:05.678Z",
      d: "2026-01-02",
      j: { a: [1, 2] },
      arr: ["x", "y"],
      nothing: null,
      b: true,
    });
  });

  it("binds array, JSON-string and Date parameters", async () => {
    const { rows } = await pool.query(
      "SELECT 'b' = ANY($1::text[]) AS hit, $2::jsonb @> '{\"a\":1}' AS contains, $3::timestamptz AS at",
      [["a", "b"], JSON.stringify({ a: 1, b: 2 }), "2026-03-04T05:06:07.000Z"]
    );
    expect(rows[0]).toEqual({ hit: true, contains: true, at: "2026-03-04T05:06:07.000Z" });
  });

  it("leaves a parameter's type to the statement, as for text", async () => {
    const { rows } = await pool.query(
      `SELECT '42'::text = $1 AS num_as_text, 'true'::text = $2 AS bool_as_text,
              $3::jsonb AS num_as_json, 4294967297::bigint = ANY($4) AS bigint_in_list`,
      [42, true, 5, [1, 4294967297]]
    );
    expect(rows[0]).toEqual({ num_as_text: true, bool_as_text: true, num_as_json: 5, bigint_in_list: true });
  });

  it("round-trips array elements that need quoting", async () => {
    const tricky = ['b"q\\z', "comma,here", "{brace}", "NULL", " spaced ", "ünï"];
    const { rows } = await pool.query("SELECT $1::text[] AS arr, $2::text = ANY($1::text[]) AS hit", [
      tricky,
      tricky[0],
    ]);
    expect(rows[0]).toEqual({ arr: tricky, hit: true });
  });

  it("raises a DatabaseError with the SQLSTATE on a unique violation", async () => {
    const failure = await pool.query(`INSERT INTO ${table} VALUES (1, 1)`).catch((error) => error);
    expect(failure).toBeInstanceOf(DatabaseError);
    expect(failure.code).toBe("23505");
    expect(failure.constraint).toBe(`${table}_pkey`);
  });

  it("answers a multi-statement batch with its last result", async () => {
    const { rows } = await pool.query("SELECT 1 AS one; SELECT 2 AS two");
    expect(rows).toEqual([{ two: 2 }]);
  });

  it("applies the server-side statement timeout to every connection", async () => {
    const { rows } = await pool.query("SHOW statement_timeout");
    expect(rows[0].statement_timeout).toBe("30s");
  });

  it("rejects a statement that outlives its client-side bound", async () => {
    await expect(
      pool.query({ text: "SELECT pg_sleep(2)", query_timeout: 200 })
    ).rejects.toThrow("Query read timeout");
  });

  it("keeps a checked-out connection's session for a transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO ${table} VALUES ($1, $2)`, [50, 5]);
      expect((await client.query(`SELECT id FROM ${table} WHERE id = 50`)).rowCount).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect((await pool.query(`SELECT id FROM ${table} WHERE id = 50`)).rowCount).toBe(0);
  });

  it("closes a connection released with `destroy`, dropping its session settings", async () => {
    const client = await pool.connect();
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await client.query("SET statement_timeout = 12345");
    client.release(true);

    const { rows } = await pool.query("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS st");
    expect(rows[0].pid).not.toBe(pid);
    expect(rows[0].st).toBe("30s");
  });

  it("caches no prepared statements on its connections", async () => {
    const client = await pool.connect();
    try {
      for (let size = 1; size <= 20; size++) {
        const placeholders = Array.from({ length: size }, (_, i) => `$${i + 1}`).join(", ");
        await client.query(`SELECT * FROM ${table} WHERE id IN (${placeholders})`, Array.from({ length: size }, (_, i) => i));
      }
      const { rows } = await client.query("SELECT count(*) AS n FROM pg_prepared_statements");
      expect(rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("logs a connection the server drops and reconnects for the next statement", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const killer = new Pool({ ...options });
      await killer.query("SELECT pg_terminate_backend($1)", [pid]);
      await killer.end();
      await Bun.sleep(200);

      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
      expect(errorSpy.mock.calls.some(([message]) => message === "Database connection lost:")).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
