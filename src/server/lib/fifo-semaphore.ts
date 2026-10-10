/**
 * A bounded-concurrency FIFO gate: up to `capacity` acquires proceed
 * immediately, further acquires queue and are woken in arrival order as
 * slots free up. Shared by the IMAP body and command budgets and by the SMTP
 * DATA budget, which differ only in what they gate, how long they are willing
 * to wait, and how they report wait time.
 */
export interface FifoSemaphore {
  /** Resolves once a slot is held. Resolves to the number of ms spent waiting (0 if a slot was free). */
  acquire(): Promise<number>;
  /**
   * Like {@link acquire}, but gives up after `timeoutMs` and resolves `null`
   * instead of holding a slot. For a caller whose peer will not wait
   * indefinitely — an SMTP sender behind a socket timeout — where queueing
   * past the deadline would hand back a slot nobody is still listening for.
   */
  acquireWithin(timeoutMs: number): Promise<number | null>;
  /** Synchronously take a slot if one is free; `false` means the caller must `acquire()` and wait. */
  tryAcquire(): boolean;
  release(): void;
  readonly capacity: number;
  inFlight(): number;
  reset(): void;
}

export const createFifoSemaphore = (capacity: number): FifoSemaphore => {
  let inFlight = 0;
  const waitQueue: Array<() => void> = [];

  const tryAcquire = (): boolean => {
    if (inFlight >= capacity) return false;
    inFlight++;
    return true;
  };

  const acquire = async (): Promise<number> => {
    if (tryAcquire()) return 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      waitQueue.push(() => {
        inFlight++;
        resolve();
      });
    });
    return performance.now() - start;
  };

  const acquireWithin = async (timeoutMs: number): Promise<number | null> => {
    if (tryAcquire()) return 0;
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const granted = await new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        inFlight++;
        resolve(true);
      };
      waitQueue.push(waiter);
      timer = setTimeout(() => {
        const queued = waitQueue.indexOf(waiter);
        // Already woken: the slot is held and `waiter` has resolved, so
        // expiring here would strand it. `release` wakes a waiter by calling
        // it, which is why presence in the queue is what says "not yet
        // granted" — and why the waiter must be dequeued before giving up,
        // or a later `release` would hand it a slot never returned.
        if (queued === -1) return;
        waitQueue.splice(queued, 1);
        resolve(false);
      }, timeoutMs);
    });
    return granted ? performance.now() - start : null;
  };

  const release = (): void => {
    // Floored: an unmatched release would otherwise admit `capacity + 1`
    // holders from then on, eroding the bound silently instead of failing.
    if (inFlight === 0) return;
    inFlight--;
    const next = waitQueue.shift();
    if (next) next();
  };

  return {
    acquire,
    acquireWithin,
    tryAcquire,
    release,
    capacity,
    inFlight: () => inFlight,
    reset: () => {
      inFlight = 0;
      waitQueue.length = 0;
    },
  };
};
