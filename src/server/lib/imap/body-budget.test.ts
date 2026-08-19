import { describe, it, expect, beforeEach } from "bun:test";

import {
  withBodyBudget,
  bodyBudgetCapacity,
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

  it("wakes multiple queued callers in FIFO order (#727 reviewoie LOW)", async () => {
    // Guards against a future refactor swapping shift/pop for LIFO or
    // waking every waiter at once. Fill capacity with holders, queue
    // three waiters A/B/C in that order, then release holders one at
    // a time and assert the completion order is A → B → C.
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withBodyBudget(() => g.promise));

    const completed: string[] = [];
    const waiters = ["A", "B", "C"] as const;
    const waiterRuns: Promise<unknown>[] = [];
    for (const name of waiters) {
      waiterRuns.push(
        withBodyBudget(async () => {
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

  it("attributes wait time to the request-scoped ledger, not a global cell", async () => {
    // The load-bearing invariant. Two concurrent request scopes run
    // side by side; each scope's wait-ledger MUST reflect ONLY its own
    // queue latency, not the other scope's. The pre-AsyncLocalStorage
    // shape wrote to a module-scoped variable that both scopes would
    // race on and overwrite.
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) =>
      runInBodyBudgetContext(() => withBodyBudget(() => g.promise))
    );

    // Queue scope A first — it'll acquire the first slot freed by a
    // filler. Its fn holds the slot briefly so scope B (queued next)
    // must wait through that hold.
    const aWait = defer<number>();
    const bWait = defer<number>();
    const scopeA = runInBodyBudgetContext(async () => {
      await withBodyBudget(async () => {
        aWait.resolve(getBodyBudgetWaitMs());
        await new Promise((r) => setTimeout(r, 40));
      });
    });
    // Yield so A's acquire hits the queue before B's.
    await nextTick();
    const scopeB = runInBodyBudgetContext(async () => {
      await withBodyBudget(async () => {
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

  it("wait ledger stays at 0 when the caller acquires without queuing", async () => {
    _resetBodyBudget();
    await runInBodyBudgetContext(async () => {
      await withBodyBudget(async () => {});
      expect(getBodyBudgetWaitMs()).toBe(0);
    });
  });

  it("getBodyBudgetWaitMs outside a context returns 0 (no throw)", () => {
    expect(getBodyBudgetWaitMs()).toBe(0);
  });
});
