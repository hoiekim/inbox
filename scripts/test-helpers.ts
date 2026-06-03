/**
 * Test-side mock helpers. Tests import these and use them in
 * `beforeAll` / `afterAll` to install + restore process-global
 * `mock.module(...)` overrides cleanly.
 *
 * Why restore: bun's `mock.module()` is process-global and has no
 * `unmock` API — once a file mocks `"pg"` with a FakePool, every
 * subsequent file in the same `bun test` process sees the mock unless
 * it's explicitly re-mocked back to real. `restoreLeaves()` re-mocks
 * each leaf to the snapshot the preload captured (`globalThis.__REAL_*`)
 * before any test file ran, so the next file starts from a known
 * baseline.
 *
 * Usage pattern:
 *
 *   import { restoreLeaves } from "test-helpers";
 *   import { afterAll, mock } from "bun:test";
 *
 *   mock.module("pg", () => ({ Pool: FakePool, ... }));
 *
 *   afterAll(restoreLeaves);
 *
 * Note: `pg`'s lazy-pool getter that lets a test file's `mock.module`
 * actually rebind the cached `Pool` reference is not yet in `client.ts`
 * — that's a separate PR (tracked by inbox#557 step 2). Until then,
 * this helper restores the SPEC binding on `pg` so a subsequent file's
 * fresh `import { Pool } from "pg"` resolves to the real Pool; tests
 * that depend on per-file pool isolation should hold until lazy-pool
 * lands.
 */
import { mock } from "bun:test";

interface RealLeaves {
  __REAL_PG: Record<string, unknown> & { default: unknown };
  __REAL_WEB_PUSH: Record<string, unknown> & { default: unknown };
}

const realLeaves = (): RealLeaves => {
  const g = globalThis as unknown as Partial<RealLeaves>;
  if (!g.__REAL_PG || !g.__REAL_WEB_PUSH) {
    throw new Error(
      "test-helpers: real leaf snapshots missing on globalThis. " +
        "Run tests via `bun test` (which preloads `scripts/test-preload.ts`).",
    );
  }
  return g as RealLeaves;
};

/**
 * Re-mock the standard set of leaf deps (`pg`, `web-push`) back to the
 * real module exports captured by the preload. Pass directly to
 * `afterAll(restoreLeaves)`.
 */
export const restoreLeaves = (): void => {
  const { __REAL_PG, __REAL_WEB_PUSH } = realLeaves();
  mock.module("pg", () => __REAL_PG);
  mock.module("web-push", () => __REAL_WEB_PUSH);
};
