import { describe, it, expect, beforeAll } from "bun:test";

// getMailHeaders and getMailHeadersDelta filter rows with a jsonb `@>`
// containment OR across the address columns (buildHeaderAddressCondition in
// repositories/mails/http.ts). Each of those columns needs a GIN
// (jsonb_path_ops) index or the planner seq-scans the whole mailbox on every
// account open and delta poll — O(mailbox) instead of O(matches) (#679).
//
// These invariants only manifest against a live Postgres planner, so — per the
// repo's established SQL-shape-guard style (see http.test.ts) — this asserts on
// the source: every address column the containment filter touches must have a
// matching GIN index declared in initialize.ts. Adding a 6th address column to
// the OR-union without an index, or dropping an index, fails this test.
describe("initialize — GIN index coverage for the address containment filter", () => {
  let initializeSource: string;
  let conditionSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    initializeSource = await fs.readFile(
      path.join(import.meta.dir, "initialize.ts"),
      "utf8"
    );
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

  // Columns given a jsonb_path_ops GIN index in initialize.ts. They are emitted
  // by a `for (const column of [...]) { ... gin (${column} jsonb_path_ops) }`
  // loop, so match the loop (asserting it still emits a jsonb_path_ops GIN
  // index) and read the column array it iterates.
  const ginIndexedColumns = () => {
    const loop = initializeSource.match(
      /for \(const column of \[([\s\S]*?)\]\)\s*\{[\s\S]*?gin \(\$\{column\} jsonb_path_ops\)/
    );
    if (!loop) throw new Error("address GIN index loop not found in initialize.ts");
    return [...loop[1].matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
  };

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
});
