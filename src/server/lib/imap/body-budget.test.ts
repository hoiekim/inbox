/**
 * Body-budget semaphore invariants (#726).
 */
import { describe, it, expect, beforeEach } from "bun:test";

import {
  withBodyBudget,
  bodyBudgetCapacity,
  bodyBudgetMemoryCap,
  bodyBudgetBytesInFlight,
  runInBodyBudgetContext,
  getBodyBudgetWaitMs,
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
      withBodyBudget(0, async () => {
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

  it("wakes multiple queued callers in FIFO order (#727 reviewoie LOW)", async () => {
    // Guards against a future refactor swapping shift/pop for LIFO or
    // waking every waiter at once. Fill capacity with holders, queue
    // three waiters A/B/C in that order, then release holders one at
    // a time and assert the completion order is A → B → C.
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withBodyBudget(0, () => g.promise));

    const completed: string[] = [];
    const waiters = ["A", "B", "C"] as const;
    const waiterRuns: Promise<unknown>[] = [];
    for (const name of waiters) {
      waiterRuns.push(
        withBodyBudget(0, async () => {
          completed.push(name);
        })
      );
      // Yield so each caller's acquire hits the queue in order.
      await nextTick();
    }

    // Release holders one by one; each wakes exactly one waiter.
    for (const g of holding) {
      g.resolve();
      await nextTick();
    }
    await Promise.all(holdingRuns);
    await Promise.all(waiterRuns);
    expect(completed).toEqual(["A", "B", "C"]);
  });

  it("queues an extra caller until a slot frees", async () => {
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withBodyBudget(0, () => g.promise));

    let extraStarted = false;
    const extra = withBodyBudget(0, async () => {
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

  it("attributes wait time to the request-scoped ledger, not a global cell", async () => {
    // The load-bearing invariant. Two concurrent request scopes run
    // side by side; each scope's wait-ledger MUST reflect ONLY its own
    // queue latency, not the other scope's. The pre-AsyncLocalStorage
    // shape wrote to a module-scoped variable that both scopes would
    // race on and overwrite.
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) =>
      runInBodyBudgetContext(() => withBodyBudget(0, () => g.promise))
    );

    // Queue scope A first — it'll acquire the first slot freed by a
    // filler. Its fn holds the slot briefly so scope B (queued next)
    // must wait through that hold.
    const aWait = defer<number>();
    const bWait = defer<number>();
    const scopeA = runInBodyBudgetContext(async () => {
      await withBodyBudget(0, async () => {
        aWait.resolve(getBodyBudgetWaitMs());
        await new Promise((r) => setTimeout(r, 40));
      });
    });
    // Yield so A's acquire hits the queue before B's.
    await nextTick();
    const scopeB = runInBodyBudgetContext(async () => {
      await withBodyBudget(0, async () => {
        bWait.resolve(getBodyBudgetWaitMs());
      });
    });
    await nextTick();

    // Release only ONE filler → wakes A (queued first). All other
    // fillers stay held throughout, so when A's fn completes and A
    // releases, B is the ONLY caller that can acquire (no other slots
    // free) → B's wait spans A's ~40 ms fn hold. A's own wait was
    // short (one microtask after filler[0] released). Distinct scopes
    // → distinct ledgers.
    holding[0].resolve();

    const [a, b] = await Promise.all([aWait.promise, bWait.promise]);
    expect(b).toBeGreaterThan(a + 20);

    // Drain remaining fillers so their runs don't hang the suite.
    holding.slice(1).forEach((g) => g.resolve());
    await scopeA;
    await scopeB;
    await Promise.all(holdingRuns);
  });

  it("releases on throw so subsequent callers still run", async () => {
    // Fill capacity with throwers.
    const results = await Promise.allSettled(
      Array.from({ length: CAP }, (_, i) =>
        withBodyBudget<never>(0, async () => {
          throw new Error(`boom-${i}`);
        })
      )
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    // A subsequent caller should acquire immediately (no leaked slots).
    let ranAfter = false;
    await withBodyBudget(0, async () => {
      ranAfter = true;
    });
    expect(ranAfter).toBe(true);
  });

  it("wait ledger stays at 0 when the caller acquires without queuing", async () => {
    _resetBodyBudget();
    await runInBodyBudgetContext(async () => {
      await withBodyBudget(0, async () => {});
      expect(getBodyBudgetWaitMs()).toBe(0);
    });
  });

  it("getBodyBudgetWaitMs outside a context returns 0 (no throw)", () => {
    expect(getBodyBudgetWaitMs()).toBe(0);
  });
});

describe("body-budget memory cap", () => {
  beforeEach(() => {
    _resetBodyBudget();
  });

  it("queues a caller whose bytes would exceed the memory cap even though the count slot is free", async () => {
    // First caller takes ~90% of the cap — well under CAP count, well under
    // memory cap. Second caller wants another ~20% — count would fit (2/CAP),
    // memory would not (110% > 100%). Must queue.
    const CAP_BYTES = bodyBudgetMemoryCap();
    const first = defer<void>();
    const firstBytes = Math.floor(CAP_BYTES * 0.9);
    const secondBytes = Math.floor(CAP_BYTES * 0.2);

    const inflight1 = withBodyBudget(firstBytes, () => first.promise);
    await nextTick();
    expect(bodyBudgetBytesInFlight()).toBe(firstBytes);

    let secondStarted = false;
    const inflight2 = withBodyBudget(secondBytes, async () => {
      secondStarted = true;
    });
    await nextTick();
    expect(secondStarted).toBe(false); // queued behind first

    first.resolve();
    await inflight1;
    await inflight2;
    expect(secondStarted).toBe(true);
    expect(bodyBudgetBytesInFlight()).toBe(0);
  });

  it("does NOT skip past a queued big caller to serve a smaller one that would fit — starvation guard", async () => {
    const CAP_BYTES = bodyBudgetMemoryCap();
    const first = defer<void>();
    const firstBytes = Math.floor(CAP_BYTES * 0.7);

    const holdA = withBodyBudget(firstBytes, () => first.promise);
    await nextTick();

    // Big waiter — wants 40% but only 30% is free → queued.
    const bigOrder: string[] = [];
    const bigWaiter = withBodyBudget(Math.floor(CAP_BYTES * 0.4), async () => {
      bigOrder.push("big");
    });
    await nextTick();

    // Small waiter arrives AFTER — wants 10% (would fit if it jumped the
    // queue). Must NOT run before the big waiter.
    const smallWaiter = withBodyBudget(Math.floor(CAP_BYTES * 0.1), async () => {
      bigOrder.push("small");
    });
    await nextTick();
    expect(bigOrder).toEqual([]); // neither ran — head-of-queue block

    first.resolve();
    await holdA;
    await bigWaiter;
    await smallWaiter;
    expect(bigOrder).toEqual(["big", "small"]); // FIFO
  });

  it("oversized single caller (bytes > cap) bypasses the memory check + logs — never deadlocks", async () => {
    const CAP_BYTES = bodyBudgetMemoryCap();
    // 2× cap: must NOT wait — release would never free enough on its own.
    const oversize = CAP_BYTES * 2;
    const started = defer<void>();

    const promise = withBodyBudget(oversize, async () => {
      started.resolve();
      return "done";
    });
    await started.promise; // proves the acquire returned without queuing
    const result = await promise;
    expect(result).toBe("done");
    expect(bodyBudgetBytesInFlight()).toBe(0);
  });

  it("releases bytes on throw so the counter doesn't leak", async () => {
    const bytes = Math.floor(bodyBudgetMemoryCap() * 0.5);
    await expect(
      withBodyBudget(bytes, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(bodyBudgetBytesInFlight()).toBe(0);
  });
});
