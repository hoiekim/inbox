/**
 * Boot-time index creation.
 *
 * Split out of `initialize.ts` because index builds are the one part of the
 * boot DDL whose cost grows with the table: a `CREATE INDEX` on `mails`
 * scales with row count, while every other statement in that block is O(1)
 * catalog work. Two consequences the plain `pool.query` path got wrong:
 *
 * 1. The pool's 30s `statement_timeout` is a build deadline. At ~278 ms per
 *    GIN index over 11,851 mails the wall lands somewhere near 1M mails. Past
 *    it the build aborts with 57014, `initializePostgres` rethrows, and
 *    `handleStartupFailure` exits the process — which `restart: always`
 *    retries into the same doomed build, forever.
 * 2. A non-concurrent build holds a SHARE lock on `mails` for its whole
 *    duration, blocking SMTP receive and IMAP STORE.
 *
 * So: `CREATE INDEX CONCURRENTLY` on a dedicated session with a build-sized
 * timeout, each build independently fallible. `createIndexes` never throws —
 * it reports whether every index is in place, and the caller withholds the
 * schema marker when one isn't so the next boot retries instead of
 * fast-pathing past a missing index.
 */

import { PoolClient, QueryConfig } from "pg";
import { pool } from "./client";
import { logger } from "../logger";

export interface IndexSpec {
  /** Must match the name inside `sql` — the invalid-leftover sweep uses it. */
  name: string;
  sql: string;
}

/**
 * Per-index build budget. Generous enough that reaching it means the build is
 * pathological rather than merely large, but still finite: an unbounded build
 * on a wedged session would hold the advisory lock for the process lifetime.
 */
export const INDEX_BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * pg's client-side read timer is independent of the server GUC, so it gets its
 * own value with room for the server to report the abort first. It cannot be
 * disabled per-query: `client.js` reads `config.query_timeout ||
 * connectionParameters.query_timeout`, so 0 falls back to the pool's 30s.
 */
const CLIENT_READ_TIMEOUT_MS = INDEX_BUILD_TIMEOUT_MS + 30_000;

/** `query_timeout` is read per-query by pg 8 but absent from `QueryConfig`. */
interface TimedQueryConfig extends QueryConfig {
  query_timeout: number;
}

/**
 * Serializes index building across instances (rolling deploy, pm2 cluster).
 * Distinct from `MIGRATION_ADVISORY_LOCK_KEY` in migration.ts — the two phases
 * are sequential within one boot but must not collide across instances.
 */
const INDEX_BUILD_ADVISORY_LOCK_KEY = 6908003;

/**
 * A `CREATE INDEX CONCURRENTLY` that fails leaves the index in the catalog
 * marked invalid. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then matches it by
 * name and no-ops, so without this sweep the retry can never succeed — the
 * container would boot cleanly forever while the index stayed unusable.
 *
 * Only runs while the build lock is held, so an invalid entry here is always a
 * dead leftover rather than another instance's in-progress build.
 */
const dropInvalidIndexes = async (
  client: PoolClient,
  names: string[]
): Promise<void> => {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname = ANY($1)`,
    [names]
  );
  for (const { relname } of rows) {
    logger.warn(`[Index] Dropping invalid leftover index ${relname} before rebuild.`);
    // `relname` came back from a match against `names`, which is built from
    // the index specs — not from user input — so interpolating it is safe.
    // `DROP INDEX` takes no parameters.
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${relname}`);
  }
};

/**
 * Builds every spec, skipping the ones already present. Returns true only when
 * the database is known to hold all of them.
 */
export const createIndexes = async (specs: IndexSpec[]): Promise<boolean> => {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error: unknown) {
    logger.error("[Index] Could not acquire a connection for index builds.", {}, error);
    return false;
  }

  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [INDEX_BUILD_ADVISORY_LOCK_KEY]
    );
    locked = rows[0]?.locked === true;
    if (!locked) {
      logger.info("[Index] Another instance holds the index-build lock — skipping.");
      return false;
    }

    // `CONCURRENTLY` cannot run inside a transaction, so the build budget has
    // to be a session-level GUC rather than `SET LOCAL`.
    await client.query(`SET statement_timeout = ${INDEX_BUILD_TIMEOUT_MS}`);

    await dropInvalidIndexes(
      client,
      specs.map((s) => s.name)
    );

    let allBuilt = true;
    for (const spec of specs) {
      const build: TimedQueryConfig = {
        text: spec.sql,
        query_timeout: CLIENT_READ_TIMEOUT_MS,
      };
      try {
        await client.query(build);
      } catch (error: unknown) {
        allBuilt = false;
        logger.error("[Index] Build failed.", { index: spec.name }, error);
      }
    }
    if (allBuilt) logger.info(`[Index] ${specs.length} index(es) created/verified.`);
    return allBuilt;
  } catch (error: unknown) {
    logger.error("[Index] Index build phase aborted.", {}, error);
    return false;
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [INDEX_BUILD_ADVISORY_LOCK_KEY])
        .catch(() => {});
    }
    // Destroy rather than return to the pool: the session carries a
    // `statement_timeout` override, and a `RESET` can't be trusted to run on a
    // connection whose last statement just failed. One discarded connection
    // per boot is free.
    client.release(true);
  }
};
