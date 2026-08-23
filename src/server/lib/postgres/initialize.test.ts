import { describe, it, expect, beforeAll } from "bun:test";
import { mailsTable } from "./models/mail";
import { buildCreateIndex } from "./database";
import { indexSpecs, maintenanceWork } from "./initialize";
import { SEARCH_VECTOR_REINDEX_CHUNK_ROWS } from "./search-vector";

const indexNameOf = (sql: string) => {
  const match = sql.match(/CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS (\w+) /);
  if (!match) throw new Error(`no index name in: ${sql}`);
  return match[1];
};

describe("initialize — GIN index coverage for the address containment filter", () => {
  let conditionSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    conditionSource = await fs.readFile(
      path.join(import.meta.dir, "repositories/mails/http.ts"),
      "utf8"
    );
  });

  // Columns filtered with `@>` inside buildHeaderAddressCondition. The two
  // template tokens resolve to their models/common.ts constant values.
  const filteredAddressColumns = () => {
    const fnMatch = conditionSource.match(
      /export const buildHeaderAddressCondition[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("buildHeaderAddressCondition not found");
    const fn = fnMatch[0]
      .replaceAll("${FROM_ADDRESS}", "from_address")
      .replaceAll("${TO_ADDRESS}", "to_address");
    return [...fn.matchAll(/(\w+)\s+@>/g)].map((m) => m[1]).sort();
  };

  const ginIndexedColumns = () =>
    mailsTable.indexes
      .filter((i) => i.using === "gin" && i.opclass === "jsonb_path_ops")
      .map((i) => i.column)
      .sort();

  it("every address column the containment filter touches has a GIN index", () => {
    const filtered = new Set(filteredAddressColumns());
    const indexed = new Set(ginIndexedColumns());
    expect(filtered.size).toBeGreaterThan(0);
    for (const column of filtered) {
      expect(indexed.has(column)).toBe(true);
    }
  });

  it("indexes exactly the five filtered address columns (no stray, none missing)", () => {
    expect(ginIndexedColumns()).toEqual([
      "bcc_address",
      "cc_address",
      "envelope_to",
      "from_address",
      "to_address",
    ]);
    expect(filteredAddressColumns()).toEqual([
      "bcc_address",
      "cc_address",
      "envelope_to",
      "from_address",
      "to_address",
    ]);
  });

  it("emits a jsonb_path_ops GIN index, not a btree, for each address column", () => {
    for (const column of ginIndexedColumns()) {
      expect(
        buildCreateIndex("mails", column, { using: "gin", opclass: "jsonb_path_ops" })
      ).toBe(
        `CREATE INDEX IF NOT EXISTS idx_mails_${column}_gin ` +
          `ON mails USING gin (${column} jsonb_path_ops)`
      );
    }
  });

  // A GIN index must not take the name buildCreateIndex would generate for a
  // btree on the same column: the model loop creates btrees first, so a name
  // collision would make `CREATE INDEX IF NOT EXISTS` silently no-op the GIN
  // index and revert the optimization with no error and no failing test.
  it("names GIN indexes distinctly from the btree on the same column", () => {
    for (const column of ginIndexedColumns()) {
      const gin = indexNameOf(
        buildCreateIndex("mails", column, { using: "gin", opclass: "jsonb_path_ops" })
      );
      expect(gin).not.toBe(indexNameOf(buildCreateIndex("mails", column)));
    }
  });
});

// The maintenance phase identifies an invalid leftover by `Statement.name` and
// drops it before rebuilding. A spec whose name doesn't match the index its own
// SQL creates would slip past the sweep, and `CREATE INDEX CONCURRENTLY IF NOT
// EXISTS` would then no-op against the leftover forever — a permanently
// unusable index with a clean boot log.
describe("initialize — index specs", () => {
  it("emits CONCURRENTLY for every index built at boot", () => {
    const specs = indexSpecs();
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.sql.startsWith("CREATE INDEX CONCURRENTLY "))).toEqual(
      []
    );
  });

  // The loop-generated specs derive both halves from one options object, so
  // they agree by construction. The search index is the one hand-written pair,
  // and therefore the only one where a typo could split them.
  it("gives the hand-written search index the name its own statement creates", () => {
    const search = indexSpecs().filter((s) => s.sql.includes("(search_vector)"));
    expect(search.map((s) => s.name)).toEqual([indexNameOf(search[0].sql)]);
  });

  it("names every index uniquely", () => {
    const names = indexSpecs().map((s) => s.name);
    const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicated).toEqual([]);
  });

  // The full-text index predates `table.indexes` and exists in production
  // under this name. Regenerating it from the column would build a second,
  // identical GIN index alongside the first.
  it("keeps the legacy name for the full-text search index", () => {
    const search = indexSpecs().filter((s) => s.sql.includes("(search_vector)"));
    expect(search.map((s) => s.name)).toEqual(["idx_mails_search"]);
  });

  // The reindex rewrites rows rather than building an index, so it belongs in
  // the same non-fatal, long-budget phase as the index builds rather than in
  // front of the listeners.
  it("hands the search-vector reindex to the maintenance phase", () => {
    const { indexes, statements } = maintenanceWork();
    expect(indexes).toEqual(indexSpecs());
    expect(statements.map((s) => s.sql.includes("SET search_vector"))).toEqual([true]);
  });

  // The statement rewrites one bounded chunk per execution, so running it once
  // leaves most of the table stale — silently, since nothing fails.
  it("marks the reindex for draining, and no index build", () => {
    expect(maintenanceWork().statements.map((s) => s.drain)).toEqual([true]);
    expect(indexSpecs().filter((s) => s.drain)).toEqual([]);
  });

  // Without a bound, the UPDATE locks every row it rewrites until it commits,
  // and concurrent flag writes queue behind it past the pool's 30s timeout.
  // Matched as a whole value, not a substring: `LIMIT 1000` is a substring of
  // `LIMIT 10000`, so a widened bound — the edit that would actually restore
  // the lock-set problem — reads as a pass under `toContain`.
  it("bounds how many rows one reindex execution rewrites", () => {
    const [reindex] = maintenanceWork().statements;
    expect(reindex.sql.match(/LIMIT (\d+)/)?.[1]).toBe(String(SEARCH_VECTOR_REINDEX_CHUNK_ROWS));
  });
});
