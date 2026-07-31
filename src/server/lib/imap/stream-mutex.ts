/**
 * Per-key mutex for streaming BODY[] serialization.
 *
 * IMAP clients (notably iOS Mail) pipeline multiple `UID FETCH X (UID
 * BODY)` for the SAME mail on ONE connection. Each starts a fresh
 * stream through `pgTextChunks` + attachment I/O; the streams run
 * concurrently, each holding its own mail-row load and chunk-in-flight
 * allocations. The count-cap + byte-cap in `body-budget.ts` bounds
 * AGGREGATE work but not DUPLICATE work — N concurrent requests for
 * the same UID still do N × PG round-trips + N × attachment reads +
 * N × in-flight chunk buffers, all for one identical response.
 *
 * This module serializes same-key streams. When a second BODY[]
 * request arrives for a key that's already streaming, it queues; when
 * the in-flight stream releases (drain to socket + `finally`), the
 * next waiter starts its own fresh stream. Under retry-storm the
 * aggregate becomes 1 in-flight per key, not N.
 *
 * Trade-off: retries pay latency (each waits for the head to finish
 * writing to its own socket), but memory stays bounded and the
 * streaming path's per-fetch sub-MB peak is preserved — no
 * materialization anywhere.
 *
 * A cache-and-share design (materialize once, tee to N sockets) would
 * cut latency further at the cost of the O(body) allocation this arc
 * has been trying to eliminate.
 */

// Absent key → available. Present → held; the array is the FIFO wait
// queue. `undefined` on the wait-queue would be ambiguous with `absent`,
// so waiters push their `resolve` fn directly and holders own the slot
// implicitly by the map entry existing.
const inflight = new Map<string, Array<() => void>>();

const acquire = async (key: string): Promise<void> => {
  const queue = inflight.get(key);
  if (!queue) {
    // Unheld — mark held with an empty wait queue and return
    // immediately. Subsequent same-key acquires will queue.
    inflight.set(key, []);
    return;
  }
  await new Promise<void>((resolve) => {
    queue.push(resolve);
  });
  // When wake() ran, ownership transferred to us; the map entry
  // remains, and any newer waiter now queues behind us.
};

const release = (key: string): void => {
  const queue = inflight.get(key);
  if (!queue) return;
  const next = queue.shift();
  if (next) {
    // Wake the head of the queue — ownership passes; map entry stays.
    next();
  } else {
    // No waiters — clear the map entry so a fresh acquire is O(1)
    // instead of the empty-array path.
    inflight.delete(key);
  }
};

/**
 * Wrap `makeStream` in a per-`key` serialization guard. Only one
 * generator per key runs at a time; concurrent same-key callers queue
 * FIFO. Ownership is released when the generator returns, throws, OR
 * the consumer abandons it (`for await` break / `.return()`) — the
 * `finally` fires on all three exit paths.
 */
export const withStreamMutex = async function* <T>(
  key: string,
  makeStream: () => AsyncIterable<T>
): AsyncGenerator<T, void, unknown> {
  await acquire(key);
  try {
    yield* makeStream();
  } finally {
    release(key);
  }
};

/** Exposed for tests. */
export const _resetStreamMutex = (): void => {
  inflight.clear();
};

/** Exposed for tests + observability — number of currently held keys. */
export const streamMutexHeldCount = (): number => inflight.size;

/** Exposed for tests + observability — waiter count for a specific key. */
export const streamMutexWaitersFor = (key: string): number =>
  inflight.get(key)?.length ?? 0;
