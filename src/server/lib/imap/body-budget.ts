/**
 * Global bounded semaphore for large-body FETCH work.
 *
 * The per-key stream mutex (`stream-mutex.ts`) serializes IDENTICAL
 * concurrent body streams for the same `(mail, sectionKey)`, and
 * PR #710 coalesced the DB read the same way. Neither bounds the
 * AGGREGATE bytes in flight across DISTINCT concurrent large-body work
 * — a common iOS Mail / K-9 pattern is one client opening several
 * account tabs at once and issuing `UID FETCH … BODY[]` in parallel
 * against different mailboxes / different UIDs. Under a count-only cap
 * (`IMAP_BODY_FETCH_CONCURRENCY=3`) three concurrent ~100 MB body
 * builds still crossed the 256 MiB cgroup and OOM-killed the container
 * (2026-07-30 23:52 UTC).
 *
 * This module holds two independent caps that acquires must both fit
 * under:
 *
 * 1. **Count** — `IMAP_BODY_FETCH_CONCURRENCY` (default 3). Bounds the
 *    NUMBER of concurrent large-body builds, cheap under normal load
 *    where each is small.
 * 2. **Bytes in flight** — `IMAP_BODY_FETCH_MEMORY_MB` (default 128 MiB,
 *    half the 256 MiB cgroup). Bounds the AGGREGATE bytes reserved by
 *    in-flight builds — the case count alone doesn't catch.
 *
 * Callers wrap large-body work in `withBodyBudget(bytes, fn)` (or
 * `withBodyBudgetStream(bytes, makeStream)` for streams) and pass the
 * pre-measured size of the wire body they're about to build. If either
 * cap would be exceeded, the caller queues on a FIFO wait list. When a
 * slot frees, the head of the queue runs if its `bytes` now fits;
 * otherwise it stays at the head and further releases keep waking it
 * until enough room is available. Metadata-only FETCH paths
 * (BODY.PEEK[HEADER], UID FLAGS, ENVELOPE) bypass the budget entirely
 * — they're cheap allocations the budget exists to protect.
 *
 * **Oversized single acquire**: if a caller's `bytes` exceeds the
 * bytes cap, waiting would deadlock (no future release can free
 * enough). Such acquires log a warning and pass through the bytes
 * check (they still count against the count cap and against
 * `bytesInFlight`, so other callers see the true pressure). This
 * matches the "large body still gets served, just possibly with a
 * cgroup kill" behavior we had pre-budget, without a hard block on
 * an outlier the operator can neither reject nor cap.
 *
 * The budget is a per-process constant, NOT per-connection. That is
 * the point: one misbehaving client shouldn't be able to squeeze the
 * rest of the process out of memory just by opening more sockets.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "server";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MEMORY_MB = 128;
const BYTES_PER_MIB = 1024 * 1024;

const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
  name: string
): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(`[body-budget] ${name} invalid, falling back to default`, {
      raw,
      default: fallback,
    });
    return fallback;
  }
  return parsed;
};

const CAPACITY = parsePositiveInt(
  process.env.IMAP_BODY_FETCH_CONCURRENCY,
  DEFAULT_CONCURRENCY,
  "IMAP_BODY_FETCH_CONCURRENCY"
);
const MEMORY_CAP_BYTES =
  parsePositiveInt(
    process.env.IMAP_BODY_FETCH_MEMORY_MB,
    DEFAULT_MEMORY_MB,
    "IMAP_BODY_FETCH_MEMORY_MB"
  ) * BYTES_PER_MIB;

let inFlight = 0;
let bytesInFlight = 0;

interface Waiter {
  bytes: number;
  wake: () => void;
}
const waitQueue: Waiter[] = [];

/**
 * Per-request wait accumulator. Same shape as before — the memory cap
 * addition didn't alter its contract.
 */
const waitStore = new AsyncLocalStorage<{ ms: number }>();

export const runInBodyBudgetContext = <T>(fn: () => T): T =>
  waitStore.run({ ms: 0 }, fn);

export const getBodyBudgetWaitMs = (): number => waitStore.getStore()?.ms ?? 0;

const hasRoom = (bytes: number): boolean => {
  if (inFlight >= CAPACITY) return false;
  // Oversized single acquires bypass the memory check (see docstring):
  // waiting for `bytes > MEMORY_CAP_BYTES` would deadlock. They still
  // occupy a count slot and add to `bytesInFlight`, so pressure is
  // visible.
  if (bytes > MEMORY_CAP_BYTES) return true;
  return bytesInFlight + bytes <= MEMORY_CAP_BYTES;
};

const acquire = async (bytes: number): Promise<void> => {
  // Non-negative sanity — a negative estimate would decrement
  // `bytesInFlight` on acquire and leak the counter.
  const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (safeBytes > MEMORY_CAP_BYTES) {
    logger.warn(
      "[body-budget] oversized acquire — bypassing memory check (see docstring)",
      { bytes: safeBytes, cap: MEMORY_CAP_BYTES }
    );
  }
  // FIFO fairness: if anyone is queued, a new small acquire must NOT
  // overtake a queued big one that couldn't fit, else the big one starves.
  // Once the queue drains, later small acquires take the fast path again.
  if (waitQueue.length === 0 && hasRoom(safeBytes)) {
    inFlight++;
    bytesInFlight += safeBytes;
    return;
  }
  const start = performance.now();
  await new Promise<void>((resolve) => {
    waitQueue.push({
      bytes: safeBytes,
      wake: () => {
        inFlight++;
        bytesInFlight += safeBytes;
        resolve();
      },
    });
  });
  const ledger = waitStore.getStore();
  if (ledger) ledger.ms += performance.now() - start;
};

const release = (bytes: number): void => {
  const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  inFlight--;
  bytesInFlight -= safeBytes;
  // Wake the queue head IF it can now fit. A big waiter at the head
  // that still doesn't fit stays there — later releases keep firing
  // until enough room is available. Do NOT skip past the head to serve
  // a smaller waiter (starvation).
  while (waitQueue.length > 0) {
    const head = waitQueue[0];
    if (!hasRoom(head.bytes)) break;
    waitQueue.shift();
    head.wake();
  }
};

/**
 * Run `fn` inside the body budget. Waits for room under BOTH the count
 * cap AND the aggregate-bytes cap. `bytes` is the pre-measured size the
 * caller expects to allocate — the streaming BODY[] path passes
 * `sumSegmentBytes(segments)`, the materializing path passes
 * `Buffer.byteLength(fullMessage)`.
 *
 * Always releases (both count and bytes), even if `fn` throws. When
 * the caller is inside a `runInBodyBudgetContext` scope, the wait time
 * (0 if immediate) is added to that scope's ledger.
 */
export const withBodyBudget = async <T>(
  bytes: number,
  fn: () => Promise<T>
): Promise<T> => {
  await acquire(bytes);
  try {
    return await fn();
  } finally {
    release(bytes);
  }
};

/**
 * Hold a budget slot (both count and bytes) for the whole lifetime of
 * a stream. The streaming BODY[] path is the LARGEST fetch shape, so
 * it must be inside the same bound as the materializing paths.
 *
 * The slot is released in `finally`, which a generator runs on
 * completion, on throw, AND when the consumer abandons it early
 * (`for await` breaking on a dead socket calls `.return()`), so an
 * aborted FETCH cannot leak a slot.
 */
export const withBodyBudgetStream = async function* <T>(
  bytes: number,
  makeStream: () => AsyncIterable<T>
): AsyncGenerator<T, void, unknown> {
  await acquire(bytes);
  try {
    yield* makeStream();
  } finally {
    release(bytes);
  }
};

/** Exposed for tests. */
export const _resetBodyBudget = (): void => {
  inFlight = 0;
  bytesInFlight = 0;
  waitQueue.length = 0;
};

export const bodyBudgetCapacity = (): number => CAPACITY;
export const bodyBudgetMemoryCap = (): number => MEMORY_CAP_BYTES;
export const bodyBudgetBytesInFlight = (): number => bytesInFlight;
