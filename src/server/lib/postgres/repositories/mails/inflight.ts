/**
 * Single-flight coalescing for identical, currently-running work.
 *
 * A `Map<string, Promise<T>>` keyed by a caller-supplied string. If a call
 * arrives while an identical one is in flight, the second caller awaits the
 * same promise instead of starting a duplicate load — memory footprint
 * becomes O(distinct-in-flight-shapes) instead of O(concurrent-callers).
 *
 * This is not a cache. The entry is deleted the instant the promise
 * settles (success or failure), so subsequent callers get a fresh load. The
 * only overlap window is "callers that arrived while the first was still
 * awaiting" — which is exactly the client-retry-storm shape that
 * multiplied per-message RSS on the OOM path.
 */
const inflight = new Map<string, Promise<unknown>>();

// NOT `async` — the whole point is that two callers with the same key get
// the SAME Promise reference so the underlying work runs once. An `async`
// wrapper would return a fresh promise per call that awaits the cached one,
// defeating the coalescing at the identity level even if only running work
// once at the mechanics level.
export function singleFlight<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  // Kick off `work` synchronously so a caller that arrives on the same
  // microtask sees the entry. `.finally` deletes on both success and throw
  // — a failed load must not stick around and short-circuit every later
  // caller with the same error.
  const promise = work().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Test-only: peek at the number of in-flight entries. */
export function inflightSize(): number {
  return inflight.size;
}

/** Test-only: clear all in-flight state. Never called by production code. */
export function inflightReset(): void {
  inflight.clear();
}
