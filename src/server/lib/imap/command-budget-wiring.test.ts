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
 * and held again for every chunk of the drain. It also pins the opposite
 * case: an UNCONTENDED inner acquire must not give the slot up at all, or a
 * per-message fetch path pays a full command-FIFO rotation per message.
 *
 * The third block covers what the budget does to a command's diagnostics and
 * to a command whose peer left while it queued — the two behaviors that are
 * only reachable once the budget is saturated, which is the state the whole
 * mechanism exists for.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { MailType } from "common";
import { logger } from "server";
import "../push";
import {
  ImapRequestHandler,
  INTERESTING_DURATION_MS,
  INTERESTING_RESPONSE_BYTES,
  INTERESTING_RSS_DELTA_MB,
} from "./handler";
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
  // Node's `end()` half-closes the WRITE side: `writable` clears immediately
  // and `destroyed` stays false until the flush completes. `closeSocket` only
  // forces `destroy()` after `CLOSE_FLUSH_TIMEOUT_MS`, so the server-initiated
  // teardown this codebase actually performs leaves a socket in exactly that
  // half-closed state for up to two seconds — the likeliest window for a
  // queued command to be woken into.
  socket.end = () => {
    socket.writable = false;
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

  it("keeps the command slot through an UNCONTENDED body-budget and stream-mutex acquire", async () => {
    const CAP = commandBudgetCapacity();

    // The budget is full and one more command is already queued behind it.
    // Any slot this fetch gives up goes to that waiter, and the reacquire
    // lands at the back of the FIFO — per message, since the fetch path
    // acquires once per response part. The inner acquires are uncontended,
    // so their fast paths must not route through the yield at all.
    for (let i = 0; i < CAP; i++) await acquireCommandBudget();
    let intruderWoken = false;
    const intruder = acquireCommandBudget().then(() => {
      intruderWoken = true;
    });
    await settle();
    expect(intruderWoken).toBe(false);

    const hold = createCommandBudgetHold(true);
    const inFlightDuringDrain: number[] = [];
    let drainedBytes = 0;

    const fetching = runInCommandBudgetContext(hold, async () => {
      const part = await buildFetchResponsePart(
        MAIL,
        { type: "BODY", peek: false, section: { type: "FULL" } },
        "doc-command-budget-uncontended",
        "INBOX"
      );
      if (!part || part.type !== "stream") {
        throw new Error("expected a stream part for BODY[]");
      }
      for await (const chunk of part.stream) {
        drainedBytes += chunk.byteLength;
        inFlightDuringDrain.push(commandBudgetInFlight());
      }
    });

    const outcome = await Promise.race([
      fetching.then(() => "drained" as const),
      new Promise<"stalled">((r) => setTimeout(() => r("stalled"), 1000)),
    ]);

    // A yielded slot here is unrecoverable until another command finishes:
    // the waiter above takes it and the fetch queues behind everything.
    expect(outcome).toBe("drained");
    expect(intruderWoken).toBe(false);
    expect(hold.held).toBe(true);
    expect(hold.waitedMs).toBe(0);
    expect(drainedBytes).toBeGreaterThan(0);
    expect(inFlightDuringDrain.length).toBeGreaterThan(0);
    expect(inFlightDuringDrain).toEqual(
      Array(inFlightDuringDrain.length).fill(CAP)
    );

    for (let i = 0; i < CAP; i++) releaseCommandBudget();
    await intruder;
    releaseCommandBudget();
  });
});

const completedLogs = (
  spy: { mock: { calls: unknown[][] } }
): Array<Record<string, number>> =>
  spy.mock.calls
    .filter(([message]) => message === "IMAP command completed")
    .map(([, context]) => context as Record<string, number>);

const droppedLogs = (
  spy: { mock: { calls: unknown[][] } }
): Array<Record<string, number>> =>
  spy.mock.calls
    .filter(([message]) => message === "IMAP command dropped")
    .map(([, context]) => context as Record<string, number>);

describe("command budget under saturation — diagnostics and dead peers", () => {
  beforeEach(() => {
    _resetCommandBudget();
  });

  afterEach(() => {
    _resetCommandBudget();
  });

  it("keeps a starved-but-fast command at INFO on the budget wait alone", async () => {
    const CAP = commandBudgetCapacity();
    for (let i = 0; i < CAP; i++) await acquireCommandBudget();

    const infoSpy = spyOn(logger, "info");
    const debugSpy = spyOn(logger, "debug");
    try {
      infoSpy.mockClear();
      debugSpy.mockClear();

      const handler = new ImapRequestHandler();
      const socket = makeMockSocket();
      handler.setSocket(socket as never);
      socket.emit("data", Buffer.from("t1 SELECT INBOX\r\n"));

      // Queued past the interesting-duration floor before a slot frees, so
      // the wait is the only axis that can make this line interesting.
      await new Promise((r) => setTimeout(r, INTERESTING_DURATION_MS + 50));
      releaseCommandBudget();

      await waitFor(
        () => completedLogs(infoSpy).length + completedLogs(debugSpy).length > 0,
        2000
      );

      const completions = completedLogs(infoSpy);
      expect(completedLogs(debugSpy)).toEqual([]);
      expect(completions.length).toBe(1);

      const payload = completions[0];
      expect(payload.waitedForCommandBudgetMs).toBeGreaterThanOrEqual(
        INTERESTING_DURATION_MS
      );
      // Nothing else about this command is interesting — so the INFO routing
      // above is attributable to the wait and to nothing else. Prod filters
      // DEBUG out, and this line is the only signal the budget is undersized.
      expect(payload.durationMs).toBeLessThan(INTERESTING_DURATION_MS);
      expect(payload.responseBytes).toBeLessThan(INTERESTING_RESPONSE_BYTES);
      expect(Math.abs(payload.rssDeltaMB)).toBeLessThan(
        INTERESTING_RSS_DELTA_MB
      );

      for (let i = 0; i < CAP - 1; i++) releaseCommandBudget();
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  // Both halves of the post-acquire liveness predicate, driven separately:
  // `destroyed` is what an abrupt peer disappearance produces, `writable`
  // is what this codebase's OWN teardown produces, and a test that only
  // reaches the first leaves the second free to be deleted.
  const abandonsQueuedCommand = (
    name: string,
    killPeer: (socket: ReturnType<typeof makeMockSocket>) => void,
    expectedPeerState: { destroyed: boolean; writable: boolean }
  ) =>
    it(name, async () => {
      const CAP = commandBudgetCapacity();
      for (let i = 0; i < CAP; i++) await acquireCommandBudget();

      const infoSpy = spyOn(logger, "info");
      const debugSpy = spyOn(logger, "debug");
      try {
        infoSpy.mockClear();
        debugSpy.mockClear();

        const handler = new ImapRequestHandler();
        const socket = makeMockSocket();
        handler.setSocket(socket as never);
        socket.emit("data", Buffer.from("t1 SELECT INBOX\r\n"));

        await nextTick();
        expect(commandBudgetInFlight()).toBe(CAP);

        killPeer(socket);
        // The predicate half this case exists to drive, asserted rather than
        // assumed. Without it a teardown that stops producing this state
        // degrades the case into a duplicate of its sibling — still green,
        // while the other half of the guard goes unpinned again.
        expect(socket.destroyed).toBe(expectedPeerState.destroyed);
        expect(socket.writable).toBe(expectedPeerState.writable);

        releaseCommandBudget();
        await waitFor(() => commandBudgetInFlight() === CAP - 1, 2000);

        // Slot handed straight back, and the response was never built: the
        // completion diagnostic is emitted from inside the dispatch it would
        // have had to enter.
        expect(commandBudgetInFlight()).toBe(CAP - 1);
        expect(completedLogs(infoSpy)).toEqual([]);
        expect(completedLogs(debugSpy)).toEqual([]);

        // The drop is accounted for rather than silent — otherwise the
        // longest waits leave no trace anywhere, and a saturated budget
        // reads as a healthy one.
        const drops = droppedLogs(infoSpy);
        expect(drops.length).toBe(1);
        expect(drops[0].cmd).toBe("SELECT INBOX");
        expect(drops[0].tag).toBe("t1");
        expect(drops[0].waitedForCommandBudgetMs).toBeGreaterThanOrEqual(0);

        for (let i = 0; i < CAP - 1; i++) releaseCommandBudget();
      } finally {
        infoSpy.mockRestore();
        debugSpy.mockRestore();
      }
    });

  // An abrupt disappearance — an over-buffered peer torn down past
  // `CLOSE_FLUSH_TIMEOUT_MS`, or a connection reset.
  abandonsQueuedCommand(
    "abandons a queued command whose peer disconnected while it waited",
    (socket) => socket.destroy(),
    { destroyed: true, writable: true }
  );

  // The server-initiated close: `SOCKET_TIMEOUT_MS` fires, `* BYE Timeout` is
  // written and `session.close()` runs `closeSocket`, which calls `end()` and
  // only destroys after a 2s flush grace. For those two seconds the socket is
  // half-closed — unwritable but not destroyed — which is the state a queued
  // command is most likely to be woken into under exactly the load this
  // budget exists to bound.
  abandonsQueuedCommand(
    "abandons a queued command whose peer was half-closed by a server-side timeout",
    (socket) => socket.end(),
    { destroyed: false, writable: false }
  );
});
