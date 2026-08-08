/**
 * The `updated` / `is_deleted` auto-columns are appended by the SQL builders,
 * so a table whose DDL declares neither must not get them — Postgres rejects
 * the whole statement. These tests drive the real `Table` methods (via the pg
 * FakePool seam) so removing the schema derivation fails here, not at runtime.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { buildUpsert } from "./database";

const queries: { sql: string; values?: unknown[] }[] = [];

const mockQuery = mock(async (sql: string, values?: unknown[]) => {
  queries.push({ sql, values });
  return { rows: [] as unknown[], rowCount: 0 as number | null };
});

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

// Import the subjects only after the pg mock is registered, so the lazy pool in
// `postgres/client.ts` instantiates FakePool instead of a real connection.
const { tables } = await import("./initialize");
const { usersTable, sessionsTable, mailboxesTable } = await import("./models");
const { resetPool } = await import("./client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

beforeEach(() => {
  queries.length = 0;
  resetPool();
});

/** The SQL of the single statement the method under test issued. */
const lastSql = (): string => {
  if (queries.length !== 1) {
    throw new Error(`expected exactly 1 query, got ${queries.length}`);
  }
  return queries[0].sql;
};

/** Columns of an `INSERT INTO t (a, b, c)` column list. */
const insertColumns = (sql: string): string[] => {
  const m = sql.match(/INSERT INTO \S+ \(([^)]*)\)/);
  if (!m) throw new Error(`not an INSERT: ${sql}`);
  return m[1].split(",").map((c) => c.trim());
};

/** Left-hand columns of an `UPDATE t SET a = $1, b = ...` assignment list. */
const setColumns = (sql: string): string[] => {
  const m = sql.match(/\bSET\s+(.*?)(?:\s+WHERE\b|\s+RETURNING\b|$)/s);
  if (!m) throw new Error(`no SET clause: ${sql}`);
  return m[1].split(",").map((c) => c.split("=")[0].trim());
};

describe("Table.insert — updated auto-column", () => {
  it("stamps updated for a table whose schema declares it", async () => {
    await usersTable.insert({ user_id: "u1", username: "alice" });
    const sql = lastSql();
    expect(insertColumns(sql)).toEqual(["updated", "user_id", "username"]);
    expect(sql).toContain("VALUES (CURRENT_TIMESTAMP, $1, $2)");
  });

  it("omits updated for mailboxes, which declares no such column", async () => {
    await mailboxesTable.insert({ user_id: "u1", name: "Archive" }, ["*"]);
    const sql = lastSql();
    expect(insertColumns(sql)).toEqual(["user_id", "name"]);
    expect(sql).not.toContain("updated");
    expect(sql).toContain("VALUES ($1, $2)");
    expect(sql).toContain("RETURNING *");
  });
});

describe("Table.update — updated auto-column", () => {
  it("stamps updated for a table whose schema declares it", async () => {
    await usersTable.update("u1", { username: "alice" });
    expect(setColumns(lastSql())).toEqual(["updated", "username"]);
  });

  it("omits updated for mailboxes (the IMAP RENAME path)", async () => {
    await mailboxesTable.update("m1", { name: "Renamed", uid_validity: 2 });
    const sql = lastSql();
    expect(setColumns(sql)).toEqual(["name", "uid_validity"]);
    expect(sql).not.toContain("updated");
    expect(sql).toContain("WHERE mailbox_id = $3");
    expect(queries[0].values).toEqual(["Renamed", 2, "m1"]);
  });

  it("returns null without querying when the caller supplies no column", async () => {
    expect(await mailboxesTable.update("m1", {})).toBeNull();
    expect(await usersTable.update("u1", {})).toBeNull();
    expect(queries).toHaveLength(0);
  });
});

describe("Table.upsert — updated auto-column", () => {
  it("stamps updated in both the column list and the DO UPDATE SET", async () => {
    await sessionsTable.upsert({ session_id: "s1", session_username: "alice" });
    const sql = lastSql();
    expect(insertColumns(sql)).toEqual(["updated", "session_id", "session_username"]);
    expect(sql).toContain(
      "DO UPDATE SET session_username = EXCLUDED.session_username, updated = CURRENT_TIMESTAMP"
    );
  });

  it("omits updated from both places for mailboxes", async () => {
    await mailboxesTable.upsert({ mailbox_id: "m1", name: "Archive" });
    const sql = lastSql();
    expect(insertColumns(sql)).toEqual(["mailbox_id", "name"]);
    expect(sql).toContain("DO UPDATE SET name = EXCLUDED.name");
    expect(sql).not.toContain("updated");
    expect(sql).toContain("RETURNING *");
  });
});

describe("Table.softDelete — auto-columns", () => {
  it("sets is_deleted and stamps updated where both are declared", async () => {
    await usersTable.softDelete("u1");
    expect(setColumns(lastSql())).toEqual(["is_deleted", "updated"]);
  });

  it("throws instead of emitting SQL for a table without is_deleted", async () => {
    await expect(mailboxesTable.softDelete("m1")).rejects.toThrow(
      /mailboxes declares no is_deleted column/
    );
    expect(queries).toHaveLength(0);
  });
});

describe("buildUpsert — empty SET degradation", () => {
  it("re-assigns the conflict key so RETURNING still yields the row", () => {
    // Every requested update column is the conflict key and the table has no
    // `updated`: DO NOTHING here would drop RETURNING and make upsert() null.
    const { sql } = buildUpsert("mailboxes", "mailbox_id", { mailbox_id: "m1" }, {
      updateColumns: ["mailbox_id"],
      stampUpdated: false,
      returning: ["*"],
    });
    expect(sql).toContain(
      "ON CONFLICT (mailbox_id) DO UPDATE SET mailbox_id = EXCLUDED.mailbox_id"
    );
    expect(sql).toContain("RETURNING *");
    expect(sql).not.toContain("DO NOTHING");
  });

  it("keeps DO NOTHING when the caller asks for no update columns", () => {
    const { sql } = buildUpsert("t", "id", { id: "1", a: "x" }, { updateColumns: [] });
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
  });
});

describe("buildUpsert — conflict clause covers only the columns the INSERT wrote", () => {
  it("drops a column whose value is undefined", () => {
    const { sql } = buildUpsert(
      "mailboxes",
      "mailbox_id",
      { mailbox_id: "m1", name: "a", parent_id: undefined },
      { updateColumns: ["mailbox_id", "name", "parent_id"], stampUpdated: false }
    );
    expect(insertColumns(sql)).toEqual(["mailbox_id", "name"]);
    expect(setColumns(sql)).toEqual(["name"]);
  });

  it("drops a column absent from data entirely", () => {
    const { sql } = buildUpsert(
      "mailboxes",
      "mailbox_id",
      { mailbox_id: "m1", name: "a" },
      { updateColumns: ["name", "parent_id"], stampUpdated: false }
    );
    expect(setColumns(sql)).toEqual(["name"]);
  });

  it("still stamps updated when every requested column was dropped", () => {
    const { sql } = buildUpsert(
      "users",
      "user_id",
      { user_id: "u1", username: undefined },
      { updateColumns: ["username"] }
    );
    expect(setColumns(sql)).toEqual(["updated"]);
  });

  it("degrades to the conflict-key no-op when nothing is left to write", () => {
    const { sql } = buildUpsert(
      "mailboxes",
      "mailbox_id",
      { mailbox_id: "m1", name: undefined },
      { updateColumns: ["name"], stampUpdated: false, returning: ["*"] }
    );
    expect(setColumns(sql)).toEqual(["mailbox_id"]);
    expect(sql).toContain("RETURNING *");
    expect(sql).not.toContain("DO NOTHING");
  });
});

describe("Table.upsert — undefined column reaches neither INSERT nor conflict SET", () => {
  it("does not null a stored password when the caller omits one", async () => {
    // `writeUser` builds `{ username, password: hashedPassword }` and leaves
    // password undefined when no password is supplied.
    await usersTable.upsert({ user_id: "u1", username: "alice", password: undefined });
    const sql = lastSql();
    expect(insertColumns(sql)).toEqual(["updated", "user_id", "username"]);
    expect(setColumns(sql)).toEqual(["username", "updated"]);
  });
});

describe("every registered table, through the real Table methods", () => {
  it("registers at least the known tables", () => {
    // Guards against an empty import silently passing the sweeps below.
    expect(tables.length).toBeGreaterThanOrEqual(10);
  });

  it("emits only columns the table's own schema declares", async () => {
    const offenders: string[] = [];
    for (const table of tables) {
      const declared = new Set(Object.keys(table.schema));
      // One non-primary-key column is enough: the auto-columns are what the
      // builders add on top of whatever the caller passes.
      const probe = Object.keys(table.schema).find((c) => c !== table.primaryKey);
      if (!probe) continue;
      const check = (columns: string[], method: string) => {
        for (const column of columns) {
          if (!declared.has(column)) offenders.push(`${table.name}.${column} (${method})`);
        }
      };

      queries.length = 0;
      await table.insert({ [probe]: "x" });
      check(insertColumns(lastSql()), "insert");

      queries.length = 0;
      await table.upsert({ [table.primaryKey]: "pk", [probe]: "x" });
      check(insertColumns(lastSql()), "upsert");

      queries.length = 0;
      await table.update("pk", { [probe]: "x" });
      check(setColumns(lastSql()), "update");

      if ("is_deleted" in table.schema) {
        queries.length = 0;
        await table.softDelete("pk");
        check(setColumns(lastSql()), "softDelete");
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares supportsSoftDelete iff the schema has an is_deleted column", () => {
    const mismatched = tables
      .filter((t) => t.supportsSoftDelete !== ("is_deleted" in t.schema))
      .map((t) => t.name);
    expect(mismatched).toEqual([]);
  });
});
