import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCommandBudgetHold,
  runInCommandBudgetContext,
  yieldCommandBudgetDuring,
} from "./command-budget-hold";
import {
  acquireCommandBudget,
  releaseCommandBudget,
  commandBudgetCapacity,
  commandBudgetInFlight,
  _resetCommandBudget,
} from "./command-budget";

const defer = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe("command-budget-hold", () => {
  beforeEach(() => {
    _resetCommandBudget();
  });

  it("gives up a held slot for the duration of the wait, and reacquires it before returning", async () => {
    await acquireCommandBudget();
    expect(commandBudgetInFlight()).toBe(1);

    const hold = createCommandBudgetHold(true);
    const gate = defer<void>();
    await runInCommandBudgetContext(hold, async () => {
      const yielding = yieldCommandBudgetDuring(() => gate.promise);

      await settle();
      expect(commandBudgetInFlight()).toBe(0);
      expect(hold.held).toBe(false);

      gate.resolve();
      await yielding;
    });

    expect(commandBudgetInFlight()).toBe(1);
    expect(hold.held).toBe(true);
    releaseCommandBudget();
  });

  it("is a no-op when the command never held a slot", async () => {
    expect(commandBudgetInFlight()).toBe(0);

    const hold = createCommandBudgetHold(false);
    let ran = false;
    await runInCommandBudgetContext(hold, () =>
      yieldCommandBudgetDuring(async () => {
        ran = true;
      })
    );

    expect(ran).toBe(true);
    expect(commandBudgetInFlight()).toBe(0);
    expect(hold.held).toBe(false);
  });

  it("reacquires the slot even when the wait rejects", async () => {
    await acquireCommandBudget();

    const hold = createCommandBudgetHold(true);
    await runInCommandBudgetContext(hold, async () => {
      await expect(
        yieldCommandBudgetDuring(() => Promise.reject(new Error("boom")))
      ).rejects.toThrow("boom");
    });

    expect(commandBudgetInFlight()).toBe(1);
    expect(hold.held).toBe(true);
    releaseCommandBudget();
  });

  it("frees the slot for another command while waiting, and queues behind it to get back in", async () => {
    const CAP = commandBudgetCapacity();
    // Every slot taken, one of them by the command that is about to wait.
    for (let i = 0; i < CAP; i++) await acquireCommandBudget();

    const hold = createCommandBudgetHold(true);
    const gate = defer<void>();
    let reacquired = false;

    const waiting = runInCommandBudgetContext(hold, async () => {
      await yieldCommandBudgetDuring(() => gate.promise);
      reacquired = true;
    });

    // The freed slot is genuinely available to someone else, not just
    // bookkept: a fresh acquire resolves while our command is still waiting.
    await settle();
    expect(commandBudgetInFlight()).toBe(CAP - 1);
    const intruderAcquired = acquireCommandBudget();
    await settle();
    await intruderAcquired;
    expect(commandBudgetInFlight()).toBe(CAP);

    // Inner wait is over, but the budget is full again — the reacquire must
    // queue rather than exceed capacity.
    gate.resolve();
    await settle();
    expect(reacquired).toBe(false);
    expect(commandBudgetInFlight()).toBe(CAP);

    releaseCommandBudget();
    await waiting;
    expect(reacquired).toBe(true);
    expect(hold.held).toBe(true);
    expect(commandBudgetInFlight()).toBe(CAP);

    for (let i = 0; i < CAP; i++) releaseCommandBudget();
  });

  it("credits the reacquire's queue time to the hold, not only the initial acquire", async () => {
    const CAP = commandBudgetCapacity();
    for (let i = 0; i < CAP; i++) await acquireCommandBudget();

    // Took its slot instantly, so the only wait this command can report is
    // the one it pays getting back in. Reported as zero, a saturated budget
    // is indistinguishable from a slow database in the completion log.
    const hold = createCommandBudgetHold(true);
    expect(hold.waitedMs).toBe(0);

    const gate = defer<void>();
    const waiting = runInCommandBudgetContext(hold, () =>
      yieldCommandBudgetDuring(() => gate.promise)
    );

    await settle();
    const intruder = acquireCommandBudget();
    await settle();
    await intruder;

    gate.resolve();
    await settle();
    expect(hold.waitedMs).toBe(0);

    const QUEUED_MS = 60;
    await new Promise((r) => setTimeout(r, QUEUED_MS));
    releaseCommandBudget();
    await waiting;

    expect(hold.held).toBe(true);
    expect(hold.waitedMs).toBeGreaterThanOrEqual(QUEUED_MS * 0.8);

    for (let i = 0; i < CAP; i++) releaseCommandBudget();
  });
});
