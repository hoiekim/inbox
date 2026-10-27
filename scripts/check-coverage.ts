/**
 * Aggregate coverage gate, run after `bun test --coverage --coverage-reporter=lcov`.
 *
 * Bun 1.4.1+ applies bunfig's `coverageThreshold` to every file rather than
 * to the total, and this tree has many files that legitimately sit at 0%
 * functions (icon components, barrels) — so no per-file threshold above ~0
 * can pass. The gate lives here instead, against the weighted total over
 * `src/`, which is the contract these thresholds were written for. Files
 * outside `src/` (test helpers, the bundles some tests write and import) are
 * left out so they cannot move the number either way.
 *
 * Ratchet the thresholds up as coverage improves.
 */
import { readFileSync } from "fs";

const THRESHOLDS = { lines: 0.5, functions: 0.28 };
const LCOV_PATH = "coverage/lcov.info";

const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
let inSrc = false;

for (const line of readFileSync(LCOV_PATH, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    inSrc = line.slice(3).startsWith("src/");
    continue;
  }
  if (!inSrc) continue;
  const [key, value] = line.split(":");
  if (key in totals) totals[key as keyof typeof totals] += Number(value);
}

// No `src/` records means the reporter's `SF:` paths changed shape, not that
// coverage is perfect; passing on empty totals would silently disable the gate.
if (totals.LF === 0 && totals.FNF === 0) {
  console.log(`FAIL no src/ records in ${LCOV_PATH} (check the SF: path format)`);
  process.exit(1);
}

const actual = {
  lines: totals.LF ? totals.LH / totals.LF : 1,
  functions: totals.FNF ? totals.FNH / totals.FNF : 1,
};

let failed = false;
for (const metric of ["lines", "functions"] as const) {
  const ok = actual[metric] >= THRESHOLDS[metric];
  if (!ok) failed = true;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${metric}: ${(actual[metric] * 100).toFixed(2)}% (threshold ${(THRESHOLDS[metric] * 100).toFixed(0)}%)`
  );
}

process.exit(failed ? 1 : 0);
