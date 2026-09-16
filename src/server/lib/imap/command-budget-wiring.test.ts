/**
 * Proves the global command budget is actually wired into `handleRequest`,
 * not just correct in isolation (`command-budget.test.ts` covers the
 * semaphore itself in a vacuum). Saturates the budget externally, dispatches
 * a real command through the handler, and checks the handler's own
 * acquire/release shows up as observable queueing + a post-completion
 * slot count — so gutting `BUDGETED_COMMAND_TYPES` or dropping the
 * `releaseCommandBudget()` call in `handler.ts` fails these, not just a
 * mutation run against the semaphore in isolation.
 *
 * The second block does the same for the yield mechanism: it drives a real
 * body-bearing `BODY[]` fetch through the production stream path with the
 * body budget saturated, pinning BOTH halves of where the command slot may
 * be given up — released while the fetch is queued behind the body budget,
 * and held again for every chunk of the drain.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import type { MailType } from "common";
import "../push";
import { ImapRequestHandler } from "./handler";
import {
  acquireCommandBudget,
  releaseCommandBudget,
  commandBudgetCapacity,
  commandBudgetInFlight,
  _resetCommandBudget,
} from "./command-budget";
import {
  createCommandBudgetHold,
  runInCommandBudgetContext,
} from "./command-budget-hold";
import {
  withBodyBudget,
  bodyBudgetCapacity,
  _resetBodyBudget,
} from "./body-budget";
import { _resetStreamMutex } from "./stream-mutex";
import { buildFetchResponsePart, writeFetchResponse } from "./fetch-helpers";

function makeMockSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    writes: string[];
    writable: boolean;
    destroyed: boolean;
    write: (data: string) => boolean;
    setTimeout: () => void;
    destroy: () => void;
    end: () => void;
  };
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (data: string) => {
    socket.writes.push(data);
    return true;
  };
  socket.setTimeout = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.end = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
}

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const nextTick = () => new Promise<void>((r) => setImmediate(r));

describe("command budget wiring through handleRequest", () => {
  beforeEach(() => {
    _resetCommandBudget();
  });

  // A failed assertion mid-test would otherwise skip the manual release
  // loop below it and leave the process-global singleton saturated for
  // every later test file in the same process.
  afterEach(() => {
    _resetCommandBudget();
  });

  it("queues a real SELECT dispatched through the handler when the budget is saturated, and releases its slot on completion", async () => {
    const CAP = commandBudgetCapacity();

    // Saturate every slot externally, standing in for other sessions'
    // in-flight budgeted commands.
    for (let i = 0; i < CAP; i++) {
      await acquireCommandBudget();
    }
    expect(commandBudgetInFlight()).toBe(CAP);

    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);
    socket.emit("data", Buffer.from("t1 SELECT INBOX\r\n"));

    // Fully saturated: the handler's own acquire must queue, not run.
    await nextTick();
    expect(socket.writes.some((w) => /^t1 (OK|NO|BAD)/.test(w))).toBe(false);
    expect(commandBudgetInFlight()).toBe(CAP);

    // Free exactly one externally-held slot — the queued SELECT should be
    // the one woken (FIFO), complete, and release its own slot back.
    releaseCommandBudget();

    await waitFor(() => socket.writes.some((w) => /^t1 (OK|NO|BAD)/.test(w)), 2000);
    expect(socket.writes.some((w) => /^t1 (OK|NO|BAD)/.test(w))).toBe(true);

    // Back to CAP - 1: the (CAP - 1) still-held external slots, and the
    // handler's own acquired-then-released slot is gone — proving
    // `releaseCommandBudget()` actually ran in `handler.ts`'s finally.
    expect(commandBudgetInFlight()).toBe(CAP - 1);

    for (let i = 0; i < CAP - 1; i++) releaseCommandBudget();
  });

  it("does not gate a cheap/protocol command (NOOP) behind a fully saturated budget", async () => {
    const CAP = commandBudgetCapacity();
    for (let i = 0; i < CAP; i++) {
      await acquireCommandBudget();
    }

    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);
    socket.emit("data", Buffer.from("t2 NOOP\r\n"));

    await waitFor(() => socket.writes.some((w) => w.includes("t2 OK NOOP completed")), 1000);
    expect(socket.writes.some((w) => w.includes("t2 OK NOOP completed"))).toBe(true);
    // The budget itself never moved — NOOP isn't in BUDGETED_COMMAND_TYPES.
    expect(commandBudgetInFlight()).toBe(CAP);

    for (let i = 0; i < CAP; i++) releaseCommandBudget();
  });
});

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

describe("command budget yield around a real body-bearing FETCH", () => {
  const MAIL = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<budget-yield@local>",
    date: new Date("2026-09-15T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "budget yield",
    text: "plain body",
    html: "<p>rich body</p>",
    attachments: [] as unknown as MailType["attachments"],
  };

  beforeEach(() => {
    _resetCommandBudget();
    _resetBodyBudget();
    _resetStreamMutex();
  });

  afterEach(() => {
    _resetCommandBudget();
    _resetBodyBudget();
    _resetStreamMutex();
  });

  it("releases the command slot while the fetch is queued on the body budget, and holds it for every chunk of the drain", async () => {
    // Every body-budget slot taken by other in-flight fetches, so this
    // fetch's own acquire — deferred to the stream's first pull, deep
    // inside the socket write — must queue.
    const bodyGate = defer();
    const bodyHolders = Array.from({ length: bodyBudgetCapacity() }, () =>
      withBodyBudget(() => bodyGate.promise)
    );
    await settle();

    // Stand in for `handler.ts`: a command-budget slot held for this
    // command, with the hold bound to its async scope.
    await acquireCommandBudget();
    expect(commandBudgetInFlight()).toBe(1);
    const hold = createCommandBudgetHold(true);

    const inFlightDuringDrain: number[] = [];
    let drainedBytes = 0;

    const fetching = runInCommandBudgetContext(hold, async () => {
      const part = await buildFetchResponsePart(
        MAIL,
        { type: "BODY", peek: false, section: { type: "FULL" } },
        "doc-command-budget-yield",
        "INBOX"
      );
      if (!part || part.type !== "stream") {
        throw new Error("expected a stream part for BODY[]");
      }
      await writeFetchResponse(
        () => true,
        async () => {},
        async (chunks) => {
          for await (const chunk of chunks) {
            drainedBytes += chunk.byteLength;
            inFlightDuringDrain.push(commandBudgetInFlight());
          }
        },
        1,
        [part]
      );
    });

    // Queued behind the body budget — the slot is genuinely back in the
    // pool, not merely bookkept as released.
    await settle();
    expect(commandBudgetInFlight()).toBe(0);
    expect(hold.held).toBe(false);
    expect(inFlightDuringDrain).toEqual([]);

    bodyGate.resolve();
    await Promise.all(bodyHolders);
    await fetching;

    // The drain itself runs with the slot held: widening the yield to cover
    // it would park a fully-written literal waiting to re-enter the command
    // FIFO, once per message.
    expect(drainedBytes).toBeGreaterThan(0);
    expect(inFlightDuringDrain.length).toBeGreaterThan(0);
    expect(inFlightDuringDrain).toEqual(
      Array(inFlightDuringDrain.length).fill(1)
    );

    expect(hold.held).toBe(true);
    expect(commandBudgetInFlight()).toBe(1);
    releaseCommandBudget();
  });

  it("releases the command slot while the fetch is queued on the stream mutex for the same body", async () => {
    const fetchPart = async () => {
      const part = await buildFetchResponsePart(
        MAIL,
        { type: "BODY", peek: false, section: { type: "FULL" } },
        "doc-command-budget-mutex",
        "INBOX"
      );
      if (!part || part.type !== "stream") {
        throw new Error("expected a stream part for BODY[]");
      }
      return part;
    };

    // Another session is already streaming this exact body, suspended
    // between chunks, so it still owns the per-key mutex.
    const holderGate = defer();
    const holderPart = await fetchPart();
    const holding = (async () => {
      let first = true;
      for await (const _chunk of holderPart.stream) {
        if (first) {
          first = false;
          await holderGate.promise;
        }
      }
    })();
    await settle();

    await acquireCommandBudget();
    const hold = createCommandBudgetHold(true);
    const inFlightDuringDrain: number[] = [];

    const fetching = runInCommandBudgetContext(hold, async () => {
      const part = await fetchPart();
      for await (const _chunk of part.stream) {
        inFlightDuringDrain.push(commandBudgetInFlight());
      }
    });

    // Queued on the mutex, not the body budget — the slot must still go back.
    await settle();
    expect(commandBudgetInFlight()).toBe(0);
    expect(hold.held).toBe(false);
    expect(inFlightDuringDrain).toEqual([]);

    holderGate.resolve();
    await holding;
    await fetching;

    expect(inFlightDuringDrain.length).toBeGreaterThan(0);
    expect(inFlightDuringDrain).toEqual(
      Array(inFlightDuringDrain.length).fill(1)
    );
    expect(hold.held).toBe(true);
    expect(commandBudgetInFlight()).toBe(1);
    releaseCommandBudget();
  });
});
