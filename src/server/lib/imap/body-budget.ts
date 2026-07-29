/**
 * Global counting semaphore for large-body FETCH work.
 *
 * `getSharedBodyResult` (`body-buffer.ts`) already coalesces IDENTICAL
 * concurrent body serializations for the same `(mail, sectionKey)`.
 * PR #710 coalesced the DB read the same way. Neither bounds the
 * NUMBER of DISTINCT concurrent large-body serializations across
 * sockets — a common iOS Mail / K-9 pattern is one client opening
 * several account tabs at once and issuing `UID FETCH … BODY[]` in
 * parallel against different mailboxes / different UIDs. Each in-flight
 * body materializes a multi-MB Buffer; the container's RSS scales
 * linearly with distinct in-flight count and can OOM despite the
 * two prior fixes.
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
 * The last budget wait latency, exposed so per-command diag logging
 * can attribute FETCH latency to budget queuing vs DB / serialization.
 * Reset by each new caller when they acquire — read it BEFORE releasing
 * or the next caller overwrites it.
 */
let lastAcquireWaitMs = 0;

export const getLastBodyBudgetWaitMs = (): number => lastAcquireWaitMs;

const acquire = (): Promise<void> => {
  const start = performance.now();
  if (inFlight < CAPACITY) {
    inFlight++;
    lastAcquireWaitMs = 0;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => {
      inFlight++;
      lastAcquireWaitMs = performance.now() - start;
      resolve();
    });
  });
};

const release = (): void => {
  inFlight--;
  const next = waitQueue.shift();
  if (next) next();
};

/**
 * Run `fn` inside the body budget. Waits for a slot if `CAPACITY`
 * large-body serializations are already in flight. Always releases,
 * even if `fn` throws.
 */
export const withBodyBudget = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};

/** Exposed for tests. */
export const _resetBodyBudget = (): void => {
  inFlight = 0;
  waitQueue.length = 0;
  lastAcquireWaitMs = 0;
};

export const bodyBudgetCapacity = (): number => CAPACITY;
