/**
 * Global counting semaphore for large-body FETCH work.
 *
 * The per-key stream mutex (`stream-mutex.ts`) serializes IDENTICAL
 * concurrent body streams for the same `(mail, sectionKey)`, and
 * PR #710 coalesced the DB read the same way. Neither bounds the
 * NUMBER of DISTINCT concurrent large-body serializations across
 * sockets — a common iOS Mail / K-9 pattern is one client opening
 * several account tabs at once and issuing `UID FETCH … BODY[]` in
 * parallel against different mailboxes / different UIDs. Each in-flight
 * body allocates its per-chunk emitter transient; the container's RSS
 * scales linearly with distinct in-flight count and can OOM despite the
 * per-key coalescing.
 *
 * This module puts a hard bound on that count. Callers wrap their
 * large-body serialization in `withBodyBudget(fn)`; if the running
 * count is at or above `IMAP_BODY_FETCH_CONCURRENCY`, the caller
 * queues on a FIFO wait list; when a slot frees, the next waiter
 * runs. Metadata-only FETCH paths (BODY.PEEK[HEADER], UID FLAGS,
 * ENVELOPE) bypass the budget entirely — they're cheap allocations
 * the budget exists to protect.
 *
 * The budget is a per-process constant, NOT per-connection. That is
 * the point: one misbehaving client shouldn't be able to squeeze the
 * rest of the process out of memory just by opening more sockets.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "server";

const DEFAULT_CONCURRENCY = 3;

const parseConcurrency = (): number => {
  const raw = process.env.IMAP_BODY_FETCH_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(
      "[body-budget] IMAP_BODY_FETCH_CONCURRENCY invalid, falling back to default",
      { raw, default: DEFAULT_CONCURRENCY }
    );
    return DEFAULT_CONCURRENCY;
  }
  return parsed;
};

const CAPACITY = parseConcurrency();

let inFlight = 0;
const waitQueue: Array<() => void> = [];

/**
 * Per-request wait accumulator. Bound at the top of the IMAP command
 * handler via `runInBodyBudgetContext(fn)`; every `withBodyBudget` call
 * that runs INSIDE `fn` (even across `await` boundaries and nested
 * async work) adds its measured wait to the SAME `{ ms }` object.
 * The handler reads the total from `getBodyBudgetWaitMs()` at the end.
 *
 * Load-bearing: without AsyncLocalStorage the wait latency would sit on
 * a module-scoped variable that concurrent handlers overwrite (handler
 * A yields inside `await withBodyBudget`, handler B on a different
 * socket acquires and writes its OWN wait time to the shared cell,
 * then A resumes and reads B's value). AsyncLocalStorage keeps each
 * request's ledger separate.
 */
const waitStore = new AsyncLocalStorage<{ ms: number }>();

export const runInBodyBudgetContext = <T>(fn: () => T): T =>
  waitStore.run({ ms: 0 }, fn);

export const getBodyBudgetWaitMs = (): number => waitStore.getStore()?.ms ?? 0;

const acquire = async (): Promise<void> => {
  if (inFlight < CAPACITY) {
    inFlight++;
    return;
  }
  const start = performance.now();
  await new Promise<void>((resolve) => {
    waitQueue.push(() => {
      inFlight++;
      resolve();
    });
  });
  const ledger = waitStore.getStore();
  if (ledger) ledger.ms += performance.now() - start;
};

const release = (): void => {
  inFlight--;
  const next = waitQueue.shift();
  if (next) next();
};

/**
 * Run `fn` inside the body budget. Waits for a slot if `CAPACITY`
 * large-body serializations are already in flight. Always releases,
 * even if `fn` throws. When the caller is inside a
 * `runInBodyBudgetContext` scope, the wait time (0 if the acquire was
 * immediate) is added to that scope's ledger.
 *
 * **No production caller as of #757** — every fetch path that used to
 * materialize a body now streams, so `withBodyBudgetStream` holds the slot
 * instead. Kept as the promise-shaped entry point to the SAME semaphore
 * (`acquire` / `release` / `waitQueue` / the ledger), which is what
 * `body-budget.test.ts` exercises directly; a materializing caller added
 * later must go through the budget rather than around it.
 */
export const withBodyBudget = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};

/**
 * Hold a budget slot for the whole lifetime of a stream.
 *
 * The streaming BODY[] path is the LARGEST fetch shape, so it must be inside
 * the same bound as the materializing paths — otherwise K concurrent sockets
 * each stream a distinct large body with no cap and the budget covers only the
 * cheaper shapes. `withBodyBudget` cannot express this: it releases when its
 * promise settles, which for a generator is before the consumer has read a
 * single chunk.
 *
 * The slot is released in `finally`, which a generator runs on completion, on
 * throw, AND when the consumer abandons it early (`for await` breaking on a
 * dead socket calls `.return()`), so an aborted FETCH cannot leak a slot.
 */
export const withBodyBudgetStream = async function* <T>(
  makeStream: () => AsyncIterable<T>
): AsyncGenerator<T, void, unknown> {
  await acquire();
  try {
    yield* makeStream();
  } finally {
    release();
  }
};

/** Exposed for tests. */
export const _resetBodyBudget = (): void => {
  inFlight = 0;
  waitQueue.length = 0;
};

export const bodyBudgetCapacity = (): number => CAPACITY;
