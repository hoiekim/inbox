import { describe, it, expect, beforeEach } from "bun:test";
import {
  withStreamMutex,
  _resetStreamMutex,
  streamMutexHeldCount,
  streamMutexWaitersFor,
} from "./stream-mutex";

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

// Drive a stream to completion, capturing yielded values in order.
const drain = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of stream) out.push(v);
  return out;
};

describe("stream-mutex", () => {
  beforeEach(() => {
    _resetStreamMutex();
  });

  it("runs concurrent different-key streams in parallel", async () => {
    const gateA = defer<void>();
    const gateB = defer<void>();
    const startedA = defer<void>();
    const startedB = defer<void>();

    const runA = drain(
      withStreamMutex("a", async function* () {
        startedA.resolve();
        await gateA.promise;
        yield "a-1";
      })
    );
    const runB = drain(
      withStreamMutex("b", async function* () {
        startedB.resolve();
        await gateB.promise;
        yield "b-1";
      })
    );

    // Both keys are DIFFERENT → both should be running (started their bodies).
    await Promise.all([startedA.promise, startedB.promise]);
    expect(streamMutexHeldCount()).toBe(2);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([runA, runB]);
    expect(streamMutexHeldCount()).toBe(0);
  });

  it("serializes concurrent same-key streams — second waits for first", async () => {
    const gate1 = defer<void>();
    const order: string[] = [];
    const started1 = defer<void>();
    const started2 = defer<void>();

    const run1 = drain(
      withStreamMutex("k", async function* () {
        started1.resolve();
        order.push("start-1");
        await gate1.promise;
        order.push("end-1");
        yield "v1";
      })
    );
    // Yield so run1's acquire fires first.
    await started1.promise;

    const run2 = drain(
      withStreamMutex("k", async function* () {
        started2.resolve();
        order.push("start-2");
        yield "v2";
      })
    );

    // run2 is queued behind run1 — MUST not have started its body yet.
    await nextTick();
    expect(order).toEqual(["start-1"]);
    expect(streamMutexWaitersFor("k")).toBe(1);

    // Release run1 → its `finally` runs → run2's body should now start.
    gate1.resolve();
    await run1;
    await started2.promise;
    await run2;
    expect(order).toEqual(["start-1", "end-1", "start-2"]);
    expect(streamMutexHeldCount()).toBe(0);
  });

  it("wakes multiple queued same-key waiters in FIFO order", async () => {
    const gate1 = defer<void>();
    const order: string[] = [];

    const run1 = drain(
      withStreamMutex("k", async function* () {
        order.push("1-start");
        await gate1.promise;
        yield "v1";
      })
    );
    await nextTick();

    const waiters = ["A", "B", "C"].map((name) =>
      drain(
        withStreamMutex("k", async function* () {
          order.push(name);
          yield name;
        })
      )
    );

    await nextTick();
    expect(order).toEqual(["1-start"]);
    expect(streamMutexWaitersFor("k")).toBe(3);

    gate1.resolve();
    await run1;
    await Promise.all(waiters);
    expect(order).toEqual(["1-start", "A", "B", "C"]);
  });

  it("releases the key when the generator throws", async () => {
    const attempt = drain(
      withStreamMutex("k", async function* () {
        yield "v1";
        throw new Error("boom");
      })
    );
    await expect(attempt).rejects.toThrow("boom");
    expect(streamMutexHeldCount()).toBe(0);

    // A subsequent acquire on the same key should succeed immediately.
    let acquired = false;
    const after = drain(
      withStreamMutex("k", async function* () {
        acquired = true;
        yield "v2";
      })
    );
    await after;
    expect(acquired).toBe(true);
  });

  it("releases the key when the consumer abandons the stream early", async () => {
    // A consumer that pulls one chunk then breaks out — `.return()` fires
    // on the generator, which runs its `finally`. Same shape as
    // writeStreamToSocket returning on a dead socket.
    const gate1 = defer<void>();
    let bodyStarted = false;
    let bodyReleased = false;
    const stream = withStreamMutex("k", async function* () {
      bodyStarted = true;
      try {
        yield "v1";
        yield "v2"; // never reached — consumer breaks after v1
      } finally {
        bodyReleased = true;
      }
    });

    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toBe("v1");
    expect(bodyStarted).toBe(true);

    // Abandon the stream mid-drain.
    await it.return?.();
    expect(bodyReleased).toBe(true);
    expect(streamMutexHeldCount()).toBe(0);

    // Next same-key acquire runs immediately.
    let ran = false;
    const later = drain(
      withStreamMutex("k", async function* () {
        ran = true;
        yield "v3";
      })
    );
    await later;
    expect(ran).toBe(true);
    // Reference gate1 to avoid an unused-variable lint.
    gate1.resolve();
  });

  it("empty-body generator releases immediately", async () => {
    await drain(
      withStreamMutex("k", async function* () {
        // yields nothing
      })
    );
    expect(streamMutexHeldCount()).toBe(0);
  });
});
