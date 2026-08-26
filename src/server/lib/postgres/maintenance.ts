/**
 * Boot maintenance: the statements whose cost grows with the size of `mails`.
 *
 * Everything else `initializePostgres` issues is O(1) catalog work — CREATE
 * TABLE, ALTER TABLE ADD COLUMN, trigger DDL. These two are not:
 *
 * - **Index builds.** ~278 ms per GIN index at 11,851 mails.
 * - **The search-vector reindex.** A table-wide UPDATE, drained a chunk at a
 *   time; the scan half alone measured ~4.2 s at 11,851 mails, so it reaches a
 *   30s wall roughly 12x sooner than any index build does.
 *
 * On the pool's 30s `statement_timeout` an abort (57014) here is fatal:
 * `initializePostgres` propagates it into `handleStartupFailure`, which exits
 * the process, so `restart: always` retries the same doomed statement forever
 * with no port ever bound.
 *
 * This module runs them on a dedicated session with a build-sized budget, each
 * statement independently fallible, serialized across instances by its own
 * advisory lock. It never throws. The caller starts it *after* the
 * listeners are bound and does not await it: index builds are `CONCURRENTLY`
 * precisely so the table stays writable during them, which is worth nothing
 * if the app isn't serving yet.
 *
 * `runBootMaintenance` reports whether the database is known to be fully in
 * step with the code's DDL, which is what gates the schema marker — writing
 * the marker while a statement is still outstanding would make every later
 * boot fast-path past it, silently and forever.
 */

import { PoolClient, QueryConfig } from "pg";
import { pool } from "./client";
import { logger } from "../logger";

export interface Statement {
  /** Identifies the statement in logs; for an index, its index name. */
  name: string;
  sql: string;
  /**
   * Re-issue until it reports no rows. A statement that rewrites the whole
   * table in one go locks every row it touches for the duration; the ones
   * written to affect a bounded slice per execution are drained in a loop so
   * the lock set stays small enough for live traffic to interleave.
   */
  drain?: boolean;
}

export interface MaintenanceWork {
  /** Index builds. Invalid leftovers are swept before these run. */
  indexes: Statement[];
  /** Row-count-scaled statements that build no index. */
  statements: Statement[];
}

/**
 * Per-statement budget, and the deadline a drain loop measures itself against.
 * Generous enough that reaching it means the work is pathological rather than
 * merely large, but still finite: an unbounded statement — or an unbounded
 * number of bounded ones — on a wedged session would hold the advisory lock for
 * the lifetime of the process.
 */
export const MAINTENANCE_TIMEOUT_MS = 10 * 60_000;

/**
 * pg's client-side read timer is independent of the server GUC, so every
 * statement here has to carry it explicitly. It cannot be disabled per-query:
 * `client.js` reads `config.query_timeout || connectionParameters.query_timeout`,
 * so 0 falls back to the pool's 30s.
 */
const CLIENT_READ_TIMEOUT_MS = MAINTENANCE_TIMEOUT_MS + 30_000;

/** `query_timeout` is read per-query by pg 8 but absent from `QueryConfig`. */
interface TimedQueryConfig extends QueryConfig {
  query_timeout: number;
}

/**
 * Serializes maintenance across instances (rolling deploy, pm2 cluster).
 * Distinct from `MIGRATION_ADVISORY_LOCK_KEY` in migration.ts — the two phases
 * are sequential within one boot but must not collide across instances.
 */
const MAINTENANCE_ADVISORY_LOCK_KEY = 6908003;

/** Runs `sql` on the maintenance session with the long budget on both sides. */
const runLongQuery = async (client: PoolClient, sql: string) => {
  const config: TimedQueryConfig = { text: sql, query_timeout: CLIENT_READ_TIMEOUT_MS };
  return client.query(config);
};

/**
 * A `CREATE INDEX CONCURRENTLY` that fails leaves the index in the catalog
 * marked invalid. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then matches it by
 * name and no-ops, so without this sweep the retry could never succeed — the
 * container would boot cleanly forever while the index stayed unusable.
 *
 * Only runs while the maintenance lock is held, so an invalid entry here is
 * always a dead leftover rather than another instance's in-progress build.
 *
 * Returns the names it could not clear, so their builds aren't reported as
 * successful when the no-op silently "succeeds".
 */
export const dropInvalidIndexes = async (
  client: PoolClient,
  names: string[],
  signal?: AbortSignal
): Promise<Set<string>> => {
  const unresolved = new Set<string>();
  // Scoped to the app's own schema: an invalid index of the same name in
  // another schema would otherwise resolve the unqualified DROP through
  // `search_path` and take out the valid index instead. Carries the long
  // budget like every other statement here — catalog lock contention must not
  // fail the probe on the pool's 30s.
  const probe: TimedQueryConfig = {
    text: `SELECT c.relname
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT i.indisvalid
              AND n.nspname = current_schema()
              AND c.relname = ANY($1)`,
    values: [names],
    query_timeout: CLIENT_READ_TIMEOUT_MS,
  };
  const { rows } = await client.query<{ relname: string }>(probe);
  for (const { relname } of rows) {
    // A `DROP INDEX CONCURRENTLY` waits out concurrent lockers on a 10-minute
    // budget, so issuing one after shutdown has started would hold the pool
    // open past the container's grace period.
    if (signal?.aborted) {
      unresolved.add(relname);
      continue;
    }
    logger.warn(`[Maintenance] Dropping invalid leftover index ${relname} before rebuild.`);
    try {
      // `relname` came back from a match against `names`, which is built from
      // the index specs — not from user input — so interpolating it is safe.
      // `DROP INDEX` takes no parameters. It gets the long budget too: it is
      // `CONCURRENTLY`, so it waits out concurrent lockers and would otherwise
      // inherit the pool's 30s and fail exactly on the boot that needs it.
      await runLongQuery(client, `DROP INDEX CONCURRENTLY IF EXISTS ${relname}`);
    } catch (error: unknown) {
      unresolved.add(relname);
      logger.error("[Maintenance] Could not drop invalid index.", { index: relname }, error);
    }
  }
  return unresolved;
};

/**
 * `complete` — the database is known to reflect every statement, so the caller
 * may write the marker. `skipped` — another instance is doing the work, or
 * shutdown cancelled it; benign, nothing to report. `incomplete` — something
 * genuinely didn't land and someone should know.
 */
export type MaintenanceResult = "complete" | "incomplete" | "skipped";

/**
 * Runs every statement, skipping index builds already satisfied.
 *
 * Aborting `signal` stops the phase at the next statement boundary and cancels
 * the backend running the current one. Without that, `pool.end()` during
 * shutdown waits on this checked-out client — up to the full budget per
 * remaining statement — and the container is SIGKILLed before the graceful
 * path finishes.
 */
export const runBootMaintenance = async (
  work: MaintenanceWork,
  signal?: AbortSignal
): Promise<MaintenanceResult> => {
  if (signal?.aborted) return "skipped";

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error: unknown) {
    if (signal?.aborted) return "skipped";
    logger.error("[Maintenance] Could not acquire a connection.", {}, error);
    return "incomplete";
  }

  let locked = false;
  let onAbort: (() => void) | undefined;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [MAINTENANCE_ADVISORY_LOCK_KEY]
    );
    locked = rows[0]?.locked === true;
    if (!locked) {
      // The winner is doing this work. Not a failure, and must not be reported
      // as one — every rolling deploy produces one loser.
      logger.info("[Maintenance] Another instance holds the lock — skipping this boot.");
      return "skipped";
    }

    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    // The in-flight statement runs on this session, so it can only be stopped
    // from another one — the abort handler cannot reuse `client`. Not `once`:
    // the sweep and the statement loop each have a cancellable statement, so
    // the handler has to survive the first firing.
    onAbort = () => {
      if (pid === undefined) return;
      logger.info("[Maintenance] Cancelling in-flight statement for shutdown.");
      void pool
        .query("SELECT pg_cancel_backend($1)", [pid])
        .catch((error: unknown) =>
          logger.error("[Maintenance] Could not cancel the in-flight statement.", { pid }, error)
        );
    };
    signal?.addEventListener("abort", onAbort);
    // `addEventListener` does not fire on an already-aborted signal, so an
    // abort that landed during `connect` / the lock / the pid read would
    // otherwise be dropped and the phase would run to completion post-SIGTERM.
    if (signal?.aborted) return "skipped";

    // `CONCURRENTLY` cannot run inside a transaction, so the budget has to be
    // a session-level GUC rather than `SET LOCAL`.
    await client.query(`SET statement_timeout = ${MAINTENANCE_TIMEOUT_MS}`);

    let complete = true;
    let unresolved = new Set<string>();
    try {
      unresolved = await dropInvalidIndexes(
        client,
        work.indexes.map((s) => s.name),
        signal
      );
    } catch (error: unknown) {
      // The probe failed, so we don't know which builds a leftover is
      // shadowing. Every build below is still attempted, but the phase cannot
      // claim completeness: a shadowed build no-ops silently, and writing the
      // marker over it is exactly how an index gets stranded forever.
      logger.error("[Maintenance] Invalid-index sweep failed.", {}, error);
      complete = false;
    }
    if (unresolved.size > 0) complete = false;
    if (signal?.aborted) return "skipped";

    for (const statement of [...work.indexes, ...work.statements]) {
      if (signal?.aborted) {
        logger.info("[Maintenance] Cancelled — stopping before the remaining statements.");
        return "skipped";
      }
      if (unresolved.has(statement.name)) continue;
      // The budget bounds one execution, and a drain issues many — so the loop
      // carries its own deadline, or a backlog that live writes keep replenishing
      // would hold the lock and a pooled connection for the life of the process.
      // Stopping early costs nothing: every rewritten chunk is committed, so the
      // next boot resumes from what is still stale.
      const deadline = Date.now() + MAINTENANCE_TIMEOUT_MS;
      let drained = false;
      try {
        do {
          const { rowCount } = await runLongQuery(client, statement.sql);
          if (!statement.drain || !rowCount) {
            drained = true;
            break;
          }
        } while (!signal?.aborted && Date.now() < deadline);
        if (!drained) {
          // An abort is a shutdown, reported by the checks below; only the
          // deadline is a condition nothing else surfaces.
          if (!signal?.aborted) {
            logger.warn("[Maintenance] Drain budget exhausted before the backlog cleared.", {
              statement: statement.name,
            });
          }
          complete = false;
        }
      } catch (error: unknown) {
        // A statement we cancelled ourselves is a shutdown, not a fault — and
        // it may be the last one, so the loop's own check would never see it.
        // Reporting it as a failure would page on every graceful stop.
        if (signal?.aborted) {
          logger.info("[Maintenance] Cancelled — stopping.");
          return "skipped";
        }
        complete = false;
        logger.error("[Maintenance] Statement failed.", { statement: statement.name }, error);
      }
    }
    // Only when something is actually outstanding: an abort landing after the
    // last statement succeeded would otherwise withhold the marker and send the
    // next boot back through every build to re-establish what already holds.
    if (signal?.aborted && !complete) return "skipped";
    if (complete) logger.info("[Maintenance] Complete — schema is at target.");
    return complete ? "complete" : "incomplete";
  } catch (error: unknown) {
    // A statement this module cancelled itself is a shutdown, not a fault —
    // reporting it as one would page on every graceful stop.
    if (signal?.aborted) return "skipped";
    logger.error("[Maintenance] Aborted.", {}, error);
    return "incomplete";
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MAINTENANCE_ADVISORY_LOCK_KEY])
        .catch(() => {});
    }
    // Destroy rather than return to the pool: the session carries a
    // `statement_timeout` override, and a `RESET` can't be trusted to run on a
    // connection whose last statement just failed. One discarded connection
    // per boot is free.
    client.release(true);
  }
};
