import { describe, it, expect } from "bun:test";
import { createFifoSemaphore } from "./fifo-semaphore";

const nextTick = () => new Promise<void>((r) => setImmediate(r));

describe("acquireWithin", () => {
  it("takes a free slot without waiting", async () => {
    const semaphore = createFifoSemaphore(1);
    expect(await semaphore.acquireWithin(50)).toBe(0);
    expect(semaphore.inFlight()).toBe(1);
  });

  it("is granted once a slot frees up before the deadline", async () => {
    const semaphore = createFifoSemaphore(1);
    semaphore.tryAcquire();

    const queued = semaphore.acquireWithin(5000);
    await nextTick();
    semaphore.release();

    expect(await queued).not.toBeNull();
    expect(semaphore.inFlight()).toBe(1);
  });

  it("gives up with null when no slot frees up in time", async () => {
    const semaphore = createFifoSemaphore(1);
    semaphore.tryAcquire();

    expect(await semaphore.acquireWithin(10)).toBeNull();
    // Only the original holder — a refused caller must not have taken one.
    expect(semaphore.inFlight()).toBe(1);
  });

  /**
   * The reason the expired waiter is spliced off the queue rather than merely
   * resolved: `release` wakes a waiter by CALLING it, so a waiter left queued
   * takes a slot nobody is listening for and never returns it. Capacity would
   * then erode by one for the life of the process, one timeout at a time.
   */
  it("does not strand a slot on a waiter that gave up", async () => {
    const semaphore = createFifoSemaphore(1);
    semaphore.tryAcquire();
    expect(await semaphore.acquireWithin(10)).toBeNull();

    semaphore.release();
    await nextTick();

    expect(semaphore.inFlight()).toBe(0);
    expect(semaphore.tryAcquire()).toBe(true);
  });

  it("wakes waiters in arrival order across both acquire forms", async () => {
    const semaphore = createFifoSemaphore(1);
    semaphore.tryAcquire();
    const woken: string[] = [];

    const first = semaphore.acquire().then(() => void woken.push("acquire"));
    const second = semaphore
      .acquireWithin(5000)
      .then(() => void woken.push("acquireWithin"));
    await nextTick();

    semaphore.release();
    await first;
    semaphore.release();
    await second;

    expect(woken).toEqual(["acquire", "acquireWithin"]);
  });
});
