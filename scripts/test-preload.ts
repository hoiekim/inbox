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

// The `server` barrel is captured here too so files that
// `mock.module("server", ...)` (currently `smtp.test.ts`) can restore
// it in `afterAll`. Bun's `mock.module` replaces the export graph-wide,
// so `smtp.test.ts`'s server stub was leaking `getUser: mockGetUser`
// into `users.test.ts`'s direct-from-`./users` import too — the CD
// break for #830. The restore closes that leak once smtp.test.ts's
// tests are done.
const realServer = require("server");
(globalThis as Record<string, unknown>).__REAL_SERVER = { ...realServer };

// `fs` is captured for the same reason as `server`: `mailgun.test.ts`
// mocks it process-globally at module load (its default + named
// `readFileSync` returns `Buffer.from("file-content")`), and under
// bun 1.3.14's test-file load order in CD, the mock leaks into
// `fetch-helpers.test.ts` (attachment BODY[] {N} arithmetic reads the
// wrong bytes/lengths) and `starttls.test.ts` (source-scan checks
// read `"file-content"` instead of the actual source). Local bun
// 1.4.0 happens not to expose the leak because file order + module
// binding differ, so `bun test` passes on this machine but CD dies —
// exact shape of the 2026-09-03 CD failure (19 fail out of 2337).
// Snapshot both the default and named surface so `afterAll` can
// re-install the real bindings on either shape.
const realFs = require("fs");
(globalThis as Record<string, unknown>).__REAL_FS = {
  ...realFs,
  default: realFs.default ?? realFs,
};
