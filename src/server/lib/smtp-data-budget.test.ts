import { describe, it, expect, beforeEach, jest } from "bun:test";
import {
  withSmtpDataBudget,
  smtpDataBudgetCapacity,
  smtpDataBudgetInFlight,
  smtpDataBudgetWaitCeilingMs,
  DataBudgetUnavailableError,
  _resetSmtpDataBudget
} from "./smtp-data-budget";

const CAP = smtpDataBudgetCapacity();

const defer = () => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const nextTick = () => new Promise<void>((r) => setImmediate(r));

/** Holds every slot until the returned gates are settled. */
const saturate = async () => {
  const gates = Array.from({ length: CAP }, () => defer());
  const held = gates.map((gate) => withSmtpDataBudget(() => gate.promise));
  await nextTick();
  return { gates, held };
};

describe("SMTP DATA budget", () => {
  beforeEach(() => {
    _resetSmtpDataBudget();
  });

  it("admits capacity transactions at once and no more", async () => {
    const started: number[] = [];
    const gates = Array.from({ length: CAP + 2 }, () => defer());
    const all = gates.map((gate, index) =>
      withSmtpDataBudget(() => {
        started.push(index);
        return gate.promise;
      })
    );
    await nextTick();

    expect(started.length).toBe(CAP);
    expect(smtpDataBudgetInFlight()).toBe(CAP);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(all);
    expect(started.length).toBe(CAP + 2);
  });

  it("delays a transaction past capacity rather than refusing it", async () => {
    const { gates, held } = await saturate();

    let delivered = false;
    const queued = withSmtpDataBudget(async () => {
      delivered = true;
    });
    await nextTick();
    expect(delivered).toBe(false);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(held);
    await queued;

    expect(delivered).toBe(true);
  });

  it("releases the slot when the transaction resolves", async () => {
    await withSmtpDataBudget(async () => undefined);
    expect(smtpDataBudgetInFlight()).toBe(0);
  });

  it("releases the slot when the transaction throws", async () => {
    await expect(
      withSmtpDataBudget(async () => {
        throw new Error("parse failed");
      })
    ).rejects.toThrow("parse failed");
    expect(smtpDataBudgetInFlight()).toBe(0);
  });

  it("refuses with a transient 421 once the wait ceiling passes", async () => {
    const { gates, held } = await saturate();

    jest.useFakeTimers();
    try {
      // The timer is registered synchronously by the call, so advancing
      // straight afterwards cannot race it.
      const refused = withSmtpDataBudget(async () => "delivered");
      jest.advanceTimersByTime(smtpDataBudgetWaitCeilingMs() + 1);
      await expect(refused).rejects.toBeInstanceOf(DataBudgetUnavailableError);
    } finally {
      jest.useRealTimers();
    }

    gates.forEach((gate) => gate.resolve());
    await Promise.all(held);
  });

  it("keeps full capacity after a refusal", async () => {
    const { gates, held } = await saturate();

    jest.useFakeTimers();
    try {
      const refused = withSmtpDataBudget(async () => undefined);
      jest.advanceTimersByTime(smtpDataBudgetWaitCeilingMs() + 1);
      await refused.catch(() => undefined);
    } finally {
      jest.useRealTimers();
    }

    gates.forEach((gate) => gate.resolve());
    await Promise.all(held);

    // A refused waiter left on the queue would have taken one of these.
    expect(smtpDataBudgetInFlight()).toBe(0);
    const started: number[] = [];
    const next = Array.from({ length: CAP }, (_, index) =>
      withSmtpDataBudget(async () => void started.push(index))
    );
    await Promise.all(next);
    expect(started.length).toBe(CAP);
  });
});

describe("DataBudgetUnavailableError", () => {
  it("answers 421 so a sending MTA retries instead of bouncing", () => {
    expect(new DataBudgetUnavailableError().responseCode).toBe(421);
  });
});
