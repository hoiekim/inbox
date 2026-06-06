/**
 * Test preload — runs ONCE before any test file in `bun test`.
 *
 * Captures real exports of leaf node-modules that tests commonly mock
 * (`pg`, `web-push`) onto `globalThis.__REAL_*` so test files can
 * `afterAll`-restore via `scripts/test-helpers.ts#restoreLeaves` and
 * not leak per-file `mock.module(...)` overrides into the next file.
 *
 * `mock.module(...)` in Bun is process-wide and has no `unmock` API —
 * once test A mocks `"pg"` with a FakePool, every subsequent test file
 * sees the mock unless explicitly re-mocked back to real. The snapshots
 * captured here are the "real" baseline.
 *
 * The snapshots are taken at preload time — BEFORE any test file has
 * a chance to call `mock.module(...)` — so they're guaranteed to be
 * the real module exports.
 *
 * We spread the full namespace (not just a hand-picked subset) because
 * these libs' methods reference each other through `module.exports` at
 * runtime — e.g. `web-push.sendNotification` internally references
 * `module.exports.getVapidHeaders`. A partial-restore snapshot crashes
 * the next file's web-push call when an internal reference is missing.
 */

const realPg = require("pg");
const realWebPush = require("web-push");

(globalThis as Record<string, unknown>).__REAL_PG = {
  ...realPg,
  default: realPg.default ?? realPg,
};
(globalThis as Record<string, unknown>).__REAL_WEB_PUSH = {
  ...realWebPush,
  default: realWebPush.default ?? realWebPush,
};
