/**
 * singleFlight coalescing invariants:
 *   1. Two callers with the same key + overlap window get the SAME promise
 *      (one work function invocation).
 *   2. Different keys → separate promises (no coalescing).
 *   3. Entry is deleted on both success AND failure — a failed load must
 *      not stick around and short-circuit future callers with the same
 *      error.
 *   4. Post-settle callers start fresh (no cache behavior).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { singleFlight, inflightSize, inflightReset } from "./inflight";

beforeEach(() => {
  inflightReset();
});

describe("singleFlight", () => {
  it("coalesces two callers with the same key into one work invocation", async () => {
    let invocations = 0;
    const gate = withGate<string>();
    const work = async () => {
      invocations += 1;
      return gate.promise;
    };

    const p1 = singleFlight("k", work);
    const p2 = singleFlight("k", work);
    // Both callers should hold the same promise reference — proof of coalescing.
    expect(p1).toBe(p2);
    expect(invocations).toBe(1);
    expect(inflightSize()).toBe(1);

    gate.resolve("body");
    expect(await p1).toBe("body");
    expect(await p2).toBe("body");
    expect(invocations).toBe(1);
  });

  it("does NOT coalesce across different keys", async () => {
    let invocations = 0;
    const gates = { a: withGate<string>(), b: withGate<string>() };
    const work = (label: "a" | "b") => async () => {
      invocations += 1;
      return gates[label].promise;
    };

    const pa = singleFlight("a", work("a"));
    const pb = singleFlight("b", work("b"));
    expect(pa).not.toBe(pb);
    expect(invocations).toBe(2);
    expect(inflightSize()).toBe(2);

    gates.a.resolve("A");
    gates.b.resolve("B");
    expect(await pa).toBe("A");
    expect(await pb).toBe("B");
  });

  it("deletes the entry on SUCCESS so subsequent callers start fresh", async () => {
    let invocations = 0;
    const run = () => singleFlight("k", async () => {
      invocations += 1;
      return invocations;
    });

    expect(await run()).toBe(1);
    // A later caller after settle must NOT ride the completed promise —
    // singleFlight is not a cache; the entry must be gone.
    expect(inflightSize()).toBe(0);
    expect(await run()).toBe(2);
  });

  it("deletes the entry on FAILURE so a failed load doesn't stick", async () => {
    let invocations = 0;
    const run = () => singleFlight("k", async () => {
      invocations += 1;
      throw new Error(`boom ${invocations}`);
    });

    // Attach handler synchronously so Bun's unhandled-rejection tracker
    // doesn't fire between throw and the caller's await.
    const first = run().catch((e: Error) => e.message);
    expect(await first).toBe("boom 1");
    // Second call must re-run work, not re-throw the cached error forever.
    expect(inflightSize()).toBe(0);
    const second = run().catch((e: Error) => e.message);
    expect(await second).toBe("boom 2");
  });

  it("callers waiting on a failing in-flight all see the SAME rejection", async () => {
    let invocations = 0;
    const gate = withGate<never>();
    const work = async () => {
      invocations += 1;
      return gate.promise;
    };

    const p1 = singleFlight("k", work);
    const p2 = singleFlight("k", work);
    expect(invocations).toBe(1);
    // Attach rejection handlers synchronously before rejecting, or Bun's
    // unhandled-rejection tracker fires between reject and the `await`.
    const settled1 = p1.catch((e: Error) => e.message);
    const settled2 = p2.catch((e: Error) => e.message);

    gate.reject(new Error("shared"));
    expect(await settled1).toBe("shared");
    expect(await settled2).toBe("shared");
    // And post-settle the entry is gone.
    expect(inflightSize()).toBe(0);
  });
});

/** Manual deferred so tests can control resolution order. */
function withGate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
