/**
 * Body-budget semaphore invariants (#726).
 */
import { describe, it, expect, beforeEach } from "bun:test";

import {
  withBodyBudget,
  bodyBudgetCapacity,
  getLastBodyBudgetWaitMs,
  _resetBodyBudget,
} from "./body-budget";

const CAP = bodyBudgetCapacity();

const defer = <T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const nextTick = () => new Promise<void>((r) => setImmediate(r));

describe("body-budget semaphore (#726)", () => {
  beforeEach(() => {
    _resetBodyBudget();
  });

  it("runs up to CAP callers concurrently", async () => {
    // Kick off CAP callers that never resolve on their own — they hold
    // their slot until we resolve them. They should all be RUNNING (not
    // queued) after a tick.
    const gates = Array.from({ length: CAP }, () => defer<string>());
    const running: string[] = [];
    const wrapped = gates.map((g, i) =>
      withBodyBudget(async () => {
        running.push(`start-${i}`);
        return await g.promise;
      })
    );

    await nextTick();
    // All CAP starts should have fired.
    expect(running).toHaveLength(CAP);

    // Release everyone.
    gates.forEach((g, i) => g.resolve(`done-${i}`));
    const results = await Promise.all(wrapped);
    expect(results).toEqual(gates.map((_, i) => `done-${i}`));
  });

  it("queues an extra caller until a slot frees", async () => {
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withBodyBudget(() => g.promise));

    let extraStarted = false;
    const extra = withBodyBudget(async () => {
      extraStarted = true;
      return "extra-done";
    });

    await nextTick();
    expect(extraStarted).toBe(false);

    // Free one slot — the extra caller should now run.
    holding[0].resolve();
    await holding[0].promise;
    await nextTick();
    expect(extraStarted).toBe(true);

    // Drain the rest so the returned promises don't hang the suite.
    holding.slice(1).forEach((g) => g.resolve());
    await Promise.all(holdingRuns);
    await extra;
  });

  it("records the acquire wait latency for the most recent acquire", async () => {
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withBodyBudget(() => g.promise));

    // A queued caller can measure its own wait time — the value is
    // overwritten on the next acquire, so capture it inside the
    // waited callback.
    const waitedCaptured = defer<number>();
    const queued = withBodyBudget(async () => {
      waitedCaptured.resolve(getLastBodyBudgetWaitMs());
      return "queued-done";
    });

    // Small delay so the queued caller has non-zero wait time.
    await new Promise((r) => setTimeout(r, 25));
    holding[0].resolve();
    const waited = await waitedCaptured.promise;
    expect(waited).toBeGreaterThan(0);

    // Drain.
    holding.slice(1).forEach((g) => g.resolve());
    await Promise.all(holdingRuns);
    await queued;
  });

  it("releases on throw so subsequent callers still run", async () => {
    // Fill capacity with throwers.
    const results = await Promise.allSettled(
      Array.from({ length: CAP }, (_, i) =>
        withBodyBudget<never>(async () => {
          throw new Error(`boom-${i}`);
        })
      )
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    // A subsequent caller should acquire immediately (no leaked slots).
    let ranAfter = false;
    await withBodyBudget(async () => {
      ranAfter = true;
    });
    expect(ranAfter).toBe(true);
  });

  it("acquire wait is 0 when the caller acquires without queuing", async () => {
    _resetBodyBudget();
    await withBodyBudget(async () => {});
    expect(getLastBodyBudgetWaitMs()).toBe(0);
  });
});
