/**
 * `mails.search_vector` DDL invariants.
 *
 * Two suites:
 *
 *  1. **Drift** (always runs) — the trigger function and the boot reindex
 *     must tokenize identically, and the `UPDATE OF` list must be exactly
 *     the columns the expression reads. These are the two ways the
 *     column-scoped trigger can silently lose a recomputation: an
 *     expression that disagrees with the trigger's (the reindex writes an
 *     authoritative-but-wrong vector, since `UPDATE OF` no longer
 *     re-derives it), or a content column missing from the `OF` list (a
 *     write to it never retokenizes).
 *
 *  2. **Behavior against a real Postgres** (opt-in) — pg-FakePool unit
 *     tests never let generated SQL meet a real schema, so the trigger
 *     semantics are only actually pinned by running them. Set
 *     `INBOX_TEST_PG_URL` to a scratch Postgres to enable:
 *
 *       INBOX_TEST_PG_URL=postgres://localhost:5432/inbox_fix732 \
 *         bun test src/server/lib/postgres/search-vector.test.ts
 *
 *     The probe builds its own `mails` table inside a throwaway schema and
 *     drops it, so it never touches `public.mails`.
 */
import { describe, it, expect, afterAll } from "bun:test";
import {
  SEARCH_VECTOR_COLUMNS,
  searchVectorExpression,
  searchVectorDdl,
  searchVectorReindexSql,
} from "./search-vector";

describe("search_vector expression", () => {
  it("uses the same expression in the trigger and the reindex", () => {
    // The ONLY difference permitted between the two is the `NEW.` prefix.
    // Anything else means the direct writer and the trigger disagree.
    const triggerSide = searchVectorExpression("NEW.").replaceAll("NEW.", "");
    expect(triggerSide).toBe(searchVectorExpression(""));
  });

  it("emits the trigger function and the reindex from that one expression", () => {
    const fn = searchVectorDdl().find((sql) => sql.includes("CREATE OR REPLACE FUNCTION"));
    expect(fn).toContain(searchVectorExpression("NEW."));
    expect(searchVectorReindexSql()).toContain(searchVectorExpression(""));
  });

  it("scopes the UPDATE trigger to exactly the columns the expression reads", () => {
    const update = searchVectorDdl().find((sql) => sql.includes("CREATE TRIGGER mails_search_update"));
    expect(update).toContain(`BEFORE UPDATE OF ${SEARCH_VECTOR_COLUMNS.join(", ")} ON mails`);
    // Every listed column is actually read by the expression, and every
    // column the expression reads is listed.
    const expr = searchVectorExpression("");
    for (const column of SEARCH_VECTOR_COLUMNS) expect(expr).toContain(column);
    const readColumns = [...expr.matchAll(/\b(subject|text|from_text|to_text)\b/g)].map(
      (m) => m[1]
    );
    expect(new Set(readColumns)).toEqual(new Set(SEARCH_VECTOR_COLUMNS));
  });

  it("fires INSERT unconditionally — there is no OF equivalent for INSERT", () => {
    const insert = searchVectorDdl().find((sql) => sql.includes("CREATE TRIGGER mails_search_insert"));
    expect(insert).toContain("BEFORE INSERT ON mails");
    expect(insert).not.toContain("OF");
  });

  it("drops the legacy combined trigger name before creating the pair", () => {
    const ddl = searchVectorDdl();
    const dropUpdate = ddl.findIndex((s) => s.includes("DROP TRIGGER IF EXISTS mails_search_update"));
    const createUpdate = ddl.findIndex((s) => s.includes("CREATE TRIGGER mails_search_update"));
    expect(dropUpdate).toBeGreaterThanOrEqual(0);
    expect(ddl.some((s) => s.includes("DROP TRIGGER IF EXISTS mails_search_insert"))).toBe(true);
    expect(dropUpdate).toBeLessThan(createUpdate);
  });
});

const PG_URL = process.env.INBOX_TEST_PG_URL;
const SCHEMA = "search_vector_probe";

// A plain `if` rather than `describe.skipIf`: the describe body still runs
// under skipIf, so a Pool would be constructed and `afterAll` would fire a
// DROP against whatever database `pg` defaults to from the environment.
if (PG_URL) describe("search_vector DDL against a real Postgres", () => {
  // `pg` is imported through the same specifier other suites mock; take the
  // preload's real snapshot when it exists so a leaked FakePool can't turn
  // this into a silent no-op.
  const pgModule = ((globalThis as Record<string, unknown>).__REAL_PG ??
    require("pg")) as typeof import("pg");
  const pool = new pgModule.Pool({ connectionString: PG_URL });

  const q = async (sql: string, params?: unknown[]) => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${SCHEMA}`);
      return await client.query(sql, params as never);
    } finally {
      client.release();
    }
  };

  const vectorOf = async (id: string): Promise<string> => {
    const r = await q(`SELECT search_vector::text AS v FROM mails WHERE id = $1`, [id]);
    return r.rows[0].v as string;
  };

  const setup = (async () => {
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`SET search_path TO ${SCHEMA}`);
      await client.query(`
        CREATE TABLE mails (
          id text PRIMARY KEY,
          subject text,
          text text,
          html text,
          from_text text,
          to_text text,
          rfc822_size integer,
          search_vector tsvector
        )
      `);
      for (const sql of searchVectorDdl()) await client.query(sql);
    } finally {
      client.release();
    }
  })();

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it("populates search_vector on INSERT", async () => {
    await setup;
    await q(
      `INSERT INTO mails (id, subject, text, from_text, to_text, rfc822_size)
       VALUES ('m1', '<alert> quarterly', 'ostrich body', 'a@x.com', 'b@x.com', 10)`
    );
    const v = await vectorOf("m1");
    expect(v).toContain("ostrich");
    // Angle-bracket blanking: the word inside <> survives tokenization.
    expect(v).toContain("alert");
    expect(v).toContain("quarter");
  });

  it("skips retokenization on a metadata-only UPDATE (the point of UPDATE OF)", async () => {
    await setup;
    await q(
      `INSERT INTO mails (id, subject, text, from_text, to_text, rfc822_size)
       VALUES ('m2', 'subj', 'walrus body', 'a@x.com', 'b@x.com', 10)`
    );
    const before = await vectorOf("m2");
    await q(`UPDATE mails SET rfc822_size = 999 WHERE id = 'm2'`);
    expect(await vectorOf("m2")).toBe(before);
    // `html` isn't in the OF list either — and isn't tokenized, so nothing
    // is lost by not firing.
    await q(`UPDATE mails SET html = '<p>zebra</p>' WHERE id = 'm2'`);
    expect(await vectorOf("m2")).toBe(before);
  });

  it("retokenizes on a content-column UPDATE, dropping the old tokens", async () => {
    await setup;
    await q(
      `INSERT INTO mails (id, subject, text, from_text, to_text, rfc822_size)
       VALUES ('m3', 'subj', 'narwhal body', 'a@x.com', 'b@x.com', 10)`
    );
    expect(await vectorOf("m3")).toContain("narwhal");
    await q(`UPDATE mails SET text = 'panther body' WHERE id = 'm3'`);
    const after = await vectorOf("m3");
    expect(after).toContain("panther");
    expect(after).not.toContain("narwhal");
    // Each remaining content column fires too.
    await q(`UPDATE mails SET subject = 'okapi' WHERE id = 'm3'`);
    expect(await vectorOf("m3")).toContain("okapi");
    await q(`UPDATE mails SET from_text = 'ibex@x.com' WHERE id = 'm3'`);
    expect(await vectorOf("m3")).toContain("ibex");
    await q(`UPDATE mails SET to_text = 'lemur@x.com' WHERE id = 'm3'`);
    expect(await vectorOf("m3")).toContain("lemur");
  });

  it("fires on a no-op content UPDATE — the OF list is by SET list, not by value change", async () => {
    await setup;
    await q(
      `INSERT INTO mails (id, subject, text, from_text, to_text, rfc822_size)
       VALUES ('m4', 'subj', 'tapir body', 'a@x.com', 'b@x.com', 10)`
    );
    // Deliberately corrupt the stored vector, then SET text to its CURRENT
    // value. If the trigger keyed off value change, the corruption would
    // survive; it keys off the SET list, so the vector is rebuilt.
    await q(`UPDATE mails SET search_vector = to_tsvector('english', 'garbage') WHERE id = 'm4'`);
    expect(await vectorOf("m4")).toContain("garbag");
    await q(`UPDATE mails SET text = text WHERE id = 'm4'`);
    const after = await vectorOf("m4");
    expect(after).toContain("tapir");
    expect(after).not.toContain("garbag");
  });

  it("lets a direct search_vector write stand — so the reindex must match the trigger", async () => {
    await setup;
    await q(
      `INSERT INTO mails (id, subject, text, from_text, to_text, rfc822_size)
       VALUES ('m5', 'subj', 'gibbon body', 'a@x.com', 'b@x.com', 10)`
    );
    // `search_vector` is not in the OF list, so the trigger does not fire
    // and does not overwrite the hand-written value. This is the removed
    // invariant the drift suite above guards.
    await q(`UPDATE mails SET search_vector = to_tsvector('english', 'manual') WHERE id = 'm5'`);
    const manual = await vectorOf("m5");
    expect(manual).toContain("manual");
    expect(manual).not.toContain("gibbon");
    // The boot reindex repairs exactly that row, because its expression is
    // the trigger's expression.
    await q(searchVectorReindexSql());
    const repaired = await vectorOf("m5");
    expect(repaired).toContain("gibbon");
    expect(repaired).not.toContain("manual");
    // Idempotent: a second reindex changes nothing.
    const second = await q(searchVectorReindexSql());
    expect(second.rowCount).toBe(0);
  });

  it("re-running the DDL is idempotent and leaves exactly the two triggers", async () => {
    await setup;
    for (const sql of searchVectorDdl()) await q(sql);
    for (const sql of searchVectorDdl()) await q(sql);
    const r = await q(`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'mails' AND n.nspname = '${SCHEMA}' AND NOT t.tgisinternal
      ORDER BY t.tgname
    `);
    expect(r.rows.map((row: { tgname: string }) => row.tgname)).toEqual([
      "mails_search_insert",
      "mails_search_update",
    ]);
    expect(r.rows[0].def).toContain("BEFORE INSERT");
    expect(r.rows[1].def).toContain(
      `BEFORE UPDATE OF ${SEARCH_VECTOR_COLUMNS.join(", ")}`
    );
  });
});
