/**
 * Tests for the SQL builders in `database.ts`, focused on the `updated`
 * auto-column.
 *
 * `buildInsert` / `buildUpsert` stamp `updated = CURRENT_TIMESTAMP` on every
 * generated INSERT. That is correct for every table whose DDL declares an
 * `updated` column and a hard failure for any table that does not — Postgres
 * rejects the statement with `column "updated" of relation "<t>" does not
 * exist`. `mailboxes` was in exactly that state, so every IMAP
 * `CREATE <mailbox>` failed (#687).
 *
 * The last test is the regression guard: it walks the real table registry and
 * asserts the builders can only emit columns that the table's own DDL
 * declares, so a future builder-written table missing `updated` fails here
 * rather than at runtime.
 */

import { describe, it, expect } from "bun:test";
import { buildInsert, buildUpsert } from "./database";
import { tables } from "./initialize";

/** Column list between the first parenthesised group of an INSERT. */
const insertColumns = (sql: string): string[] => {
  const m = sql.match(/INSERT INTO \S+ \(([^)]*)\)/);
  if (!m) throw new Error(`not an INSERT: ${sql}`);
  return m[1].split(",").map((c) => c.trim());
};

describe("buildInsert — updated auto-column", () => {
  it("stamps updated = CURRENT_TIMESTAMP by default", () => {
    const { sql, values } = buildInsert("users", { user_id: "u1", username: "a" });
    expect(insertColumns(sql)).toEqual(["updated", "user_id", "username"]);
    expect(sql).toContain("VALUES (CURRENT_TIMESTAMP, $1, $2)");
    expect(values).toEqual(["u1", "a"]);
  });

  it("stamps updated when the option is explicitly true", () => {
    const { sql } = buildInsert("users", { user_id: "u1" }, undefined, {
      stampUpdated: true,
    });
    expect(insertColumns(sql)).toEqual(["updated", "user_id"]);
  });

  it("omits updated when stampUpdated is false", () => {
    const { sql, values } = buildInsert("mailboxes", { user_id: "u1", name: "Archive" }, undefined, {
      stampUpdated: false,
    });
    expect(insertColumns(sql)).toEqual(["user_id", "name"]);
    expect(sql).not.toContain("updated");
    expect(sql).toContain("VALUES ($1, $2)");
    expect(values).toEqual(["u1", "Archive"]);
  });

  it("keeps placeholder numbering 1-based when updated is omitted", () => {
    const { sql } = buildInsert("mailboxes", { a: 1, b: 2, c: 3 }, undefined, {
      stampUpdated: false,
    });
    expect(sql).toContain("VALUES ($1, $2, $3)");
  });

  it("still honours the RETURNING clause with updated omitted", () => {
    const { sql } = buildInsert("mailboxes", { name: "Archive" }, ["*"], {
      stampUpdated: false,
    });
    expect(sql).toContain("RETURNING *");
  });
});

describe("buildUpsert — updated auto-column", () => {
  it("stamps updated in both the column list and the DO UPDATE SET by default", () => {
    const { sql } = buildUpsert("users", "user_id", { user_id: "u1", username: "a" }, {
      updateColumns: ["username"],
    });
    expect(insertColumns(sql)).toEqual(["updated", "user_id", "username"]);
    expect(sql).toContain("DO UPDATE SET username = EXCLUDED.username, updated = CURRENT_TIMESTAMP");
  });

  it("omits updated from both places when stampUpdated is false", () => {
    const { sql } = buildUpsert("mailboxes", "mailbox_id", { mailbox_id: "m1", name: "Archive" }, {
      updateColumns: ["name"],
      stampUpdated: false,
    });
    expect(insertColumns(sql)).toEqual(["mailbox_id", "name"]);
    expect(sql).toContain("DO UPDATE SET name = EXCLUDED.name");
    expect(sql).not.toContain("updated");
  });

  it("degrades to DO NOTHING when omitting updated leaves an empty SET list", () => {
    // Every requested update column is the conflict key, so after the
    // primary-key filter nothing is left to write. An empty `SET` list is a
    // syntax error; DO NOTHING is the correct degenerate form.
    const { sql } = buildUpsert("mailboxes", "mailbox_id", { mailbox_id: "m1" }, {
      updateColumns: ["mailbox_id"],
      stampUpdated: false,
    });
    expect(sql).toContain("ON CONFLICT (mailbox_id) DO NOTHING");
    expect(sql).not.toContain("DO UPDATE SET");
  });

  it("still emits DO NOTHING when updateColumns is empty, regardless of stampUpdated", () => {
    for (const stampUpdated of [true, false]) {
      const { sql } = buildUpsert("t", "id", { id: "1", a: "x" }, { stampUpdated });
      expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    }
  });
});

describe("builder columns vs. table DDL (regression guard for #687)", () => {
  it("registers at least the known tables", () => {
    // Guards against an empty import silently passing the sweep below.
    expect(tables.length).toBeGreaterThanOrEqual(10);
  });

  it("only emits columns the table's own schema declares", () => {
    const offenders: string[] = [];
    for (const table of tables) {
      const declared = new Set(Object.keys(table.schema));
      // A single non-primary-key column is enough to exercise the auto-column
      // prefix; the per-row columns come straight from the caller's data.
      const probe = Object.keys(table.schema).find((c) => c !== table.primaryKey);
      if (!probe) continue;
      const { sql } = buildInsert(table.name, { [probe]: "x" }, undefined, {
        stampUpdated: "updated" in table.schema,
      });
      for (const column of insertColumns(sql)) {
        if (!declared.has(column)) offenders.push(`${table.name}.${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mailboxes declares no updated column, so its INSERT must not stamp one", () => {
    // Pins the specific shape of #687: the bug was invisible because the unit
    // tests mocked the pool, so the generated SQL never met the real schema.
    const mailboxes = tables.find((t) => t.name === "mailboxes");
    expect(mailboxes).toBeDefined();
    expect("updated" in mailboxes!.schema).toBe(false);
    const { sql } = buildInsert(mailboxes!.name, { name: "Archive" }, undefined, {
      stampUpdated: "updated" in mailboxes!.schema,
    });
    expect(sql).not.toContain("updated");
  });
});
