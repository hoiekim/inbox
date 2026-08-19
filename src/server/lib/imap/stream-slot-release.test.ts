import { describe, it, expect, beforeEach } from "bun:test";

import {
  withBodyBudget,
  withBodyBudgetStream,
  bodyBudgetCapacity,
  _resetBodyBudget,
} from "./body-budget";
import {
  withStreamMutex,
  streamMutexHeldCount,
  _resetStreamMutex,
} from "./stream-mutex";
import { writeStreamToSocket } from "./chunked-write";

const CAP = bodyBudgetCapacity();

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** Minimal `ChunkedWriteSocket` whose `teardown()` mimics socket.destroy(). */
const makeSocket = () => {
  const listeners = new Map<string, Array<() => void>>();
  const socket = {
    destroyed: false,
    writable: true,
    write: () => true,
    once(event: string, fn: () => void) {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, fn]);
      return socket;
    },
    off() {
      return socket;
    },
    teardown() {
      socket.destroyed = true;
      socket.writable = false;
      (listeners.get("close") ?? []).forEach((fn) => fn());
    },
  };
  return socket;
};

/** The production generator shape: mutex on the outside, budget on the inside. */
const bodyStream = (key: string, chunks: number) =>
  withStreamMutex(key, () =>
    withBodyBudgetStream(async function* () {
      for (let i = 0; i < chunks; i++) yield Buffer.from(`chunk-${i}`);
    })
  ) as AsyncIterable<Buffer>;

/** Occupy every budget slot; resolve the returned gate to hand them all back. */
const fillBudget = () => {
  const gate = defer();
  const holders = Array.from({ length: CAP }, () =>
    withBodyBudget(() => gate.promise)
  );
  return { release: gate.resolve, done: Promise.all(holders) };
};

/**
 * How many permits the budget can hand out right now. Asserting the full CAP
 * (rather than "at least one is free") is what catches a single leaked permit
 * — with the default capacity of 3, a one-permit leak is invisible to a lone
 * probe.
 */
const availablePermits = async (): Promise<number> => {
  const gate = defer();
  let acquired = 0;
  const probes = Array.from({ length: CAP }, () =>
    withBodyBudget(async () => {
      acquired++;
      await gate.promise;
    })
  );
  await settle();
  const observed = acquired;
  gate.resolve();
  await Promise.all(probes);
  return observed;
};

describe("stream slot release on consumer death (#728)", () => {
  beforeEach(() => {
    _resetBodyBudget();
    _resetStreamMutex();
  });

  it("returns the slot when the socket dies while the consumer is queued on the budget", async () => {
    const { release, done } = fillBudget();
    await settle();

    const socket = makeSocket();
    const consumer = writeStreamToSocket(socket, bodyStream("queued", 2), () => undefined);
    await settle(); // consumer is now parked on the budget acquire

    socket.teardown();
    release();
    await done;
    await consumer;
    await settle();

    expect(await availablePermits()).toBe(CAP);
    expect(streamMutexHeldCount()).toBe(0);
  });

  it("returns the slot when the socket dies after the first chunk is written", async () => {
    const socket = makeSocket();
    const stream = bodyStream("midstream", 5);

    let delivered = 0;
    for await (const chunk of stream) {
      delivered++;
      expect(chunk.byteLength).toBeGreaterThan(0);
      socket.teardown();
      if (socket.destroyed) break;
    }
    await settle();

    expect(delivered).toBe(1);
    expect(await availablePermits()).toBe(CAP);
    expect(streamMutexHeldCount()).toBe(0);
  });

  it("consumes no slot at all when the socket is already destroyed before the write starts", async () => {
    const socket = makeSocket();
    socket.teardown();

    const written = await writeStreamToSocket(socket, bodyStream("dead", 3), () => undefined);
    await settle();

    expect(written).toBe(0);
    expect(await availablePermits()).toBe(CAP);
    expect(streamMutexHeldCount()).toBe(0);
  });

  it("runs the generator's finally when writeStreamToSocket returns early mid-loop", async () => {
    // Direct assertion on the unwind contract the two wrappers rely on:
    // the early `return` inside `for await` must reach the generator.
    const socket = makeSocket();
    let finallyRan = false;

    const chunks = (async function* () {
      try {
        yield Buffer.from("first");
        yield Buffer.from("second");
      } finally {
        finallyRan = true;
      }
    })();

    // Die on the socket the moment the first chunk lands, so the loop takes
    // its `if (socket.destroyed) return written` branch on the next pass.
    const originalWrite = socket.write;
    socket.write = () => {
      socket.teardown();
      return originalWrite();
    };

    const written = await writeStreamToSocket(socket, chunks, () => undefined);
    await settle();

    expect(written).toBe("first".length);
    expect(finallyRan).toBe(true);
  });

  it("frees the queued waiter's slot for the NEXT fetch, so capacity does not decay", async () => {
    // The failure the issue describes is monotonic decay: each abandoned
    // waiter permanently costs one permit. Run the abandon cycle twice and
    // assert full capacity is still available afterwards.
    for (const round of ["round-1", "round-2"]) {
      const { release, done } = fillBudget();
      await settle();

      const socket = makeSocket();
      const consumer = writeStreamToSocket(socket, bodyStream(round, 2), () => undefined);
      await settle();

      socket.teardown();
      release();
      await done;
      await consumer;
      await settle();
    }

    // All CAP permits must still be grantable simultaneously.
    expect(await availablePermits()).toBe(CAP);
    expect(streamMutexHeldCount()).toBe(0);
  });
});
