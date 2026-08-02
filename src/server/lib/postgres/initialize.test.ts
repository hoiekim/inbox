import { describe, it, expect, beforeAll } from "bun:test";
import { mailsTable } from "./models/mail";
import { buildCreateIndex } from "./database";

// getMailHeaders and getMailHeadersDelta filter rows with a jsonb `@>`
// containment OR across the address columns (buildHeaderAddressCondition in
// repositories/mails/http.ts). Each of those columns needs a GIN
// (jsonb_path_ops) index or the planner seq-scans the whole mailbox on every
// account open and delta poll — O(mailbox) instead of O(matches) (#679).
//
// The index set is declared on the model, so that half asserts on the real
// definition. The filter side only manifests against a live planner, so — per
// the repo's established SQL-shape-guard style (see http.test.ts) — it is read
// off the source. Adding a 6th address column to the OR-union without an index,
// or dropping an index, fails this test.
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
      expect(buildCreateIndex("mails", column, undefined, "gin", "jsonb_path_ops")).toBe(
        `CREATE INDEX IF NOT EXISTS idx_mails_${column}_gin ` +
          `ON mails USING gin (${column} jsonb_path_ops)`
      );
    }
  });

  // A GIN index must not take the name buildCreateIndex would generate for a
  // btree on the same column: the model loop creates btrees first, so a name
  // collision would make `CREATE INDEX IF NOT EXISTS` silently no-op the GIN
  // index and revert the optimization with no error and no failing test.
  const indexNameOf = (sql: string) => {
    const match = sql.match(/CREATE INDEX IF NOT EXISTS (\w+) /);
    if (!match) throw new Error(`no index name in: ${sql}`);
    return match[1];
  };

  it("names GIN indexes distinctly from the btree on the same column", () => {
    for (const column of ginIndexedColumns()) {
      const gin = indexNameOf(
        buildCreateIndex("mails", column, undefined, "gin", "jsonb_path_ops")
      );
      expect(gin).not.toBe(indexNameOf(buildCreateIndex("mails", column)));
    }
  });
});
