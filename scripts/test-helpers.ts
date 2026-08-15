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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

/**
 * Stage a temporary certificate/key pair and drive the two env vars the TLS
 * availability gate (`src/server/lib/tls.ts`) reads.
 *
 * The staged files hold junk rather than a real key pair on purpose: the gate
 * only stats them, so presence is the whole contract, and no test in the repo
 * should carry a PEM private key. A consumer that hands them to OpenSSL — the
 * STARTTLS upgrade path — gets a parse failure, which is what those tests
 * assert against.
 */
export const createTlsEnvFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "tls-fixture-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  writeFileSync(certPath, "cert");
  writeFileSync(keyPath, "key");

  const original = {
    SSL_CERTIFICATE: process.env.SSL_CERTIFICATE,
    SSL_CERTIFICATE_KEY: process.env.SSL_CERTIFICATE_KEY,
  };

  const apply = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  return {
    certPath,
    keyPath,
    /** Path inside the fixture directory that is guaranteed NOT to exist. */
    absentPath: (name: string) => join(dir, name),
    /** Point the env at the given paths; `undefined` unsets that variable. */
    use: (cert?: string, key?: string) =>
      apply({ SSL_CERTIFICATE: cert, SSL_CERTIFICATE_KEY: key }),
    restore: () => apply(original),
    cleanup: () => {
      apply(original);
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
