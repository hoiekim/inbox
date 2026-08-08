/**
 * Per-session command-drain serialization test.
 *
 * Node emits `data` events synchronously per TCP segment. Before this
 * fix, the `socket.on("data", async …)` handler was itself async — so
 * pipelined commands that arrived in separate segments would spawn
 * concurrent async processing loops. Each loop mutated the shared
 * `buffer` AND awaited `handleRequest` in parallel, and inside a
 * long-running FETCH the concurrent handler's synchronous `write()`
 * would inject headers into the previous response's still-streaming
 * literal — corrupting the wire stream and desyncing the client.
 *
 * The fix serializes: the `data` event is now synchronous (buffer
 * append only), then a single `drainCommands` loop pumps one command
 * at a time under a `draining` guard. RFC 3501 permits serial
 * execution.
 *
 * These tests pin the invariants:
 *  1) Every command in a burst still gets a tagged completion (no drops).
 *  2) The number of `OK` responses matches the number of commands sent
 *     across N separate data events (the drain doesn't wedge under
 *     re-entrance).
 *  3) The order of tagged completions matches the order commands were
 *     sent (no interleaving).
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "events";
import "../push";
import { ImapRequestHandler } from "./handler";

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
  socket.end = () => {};
  return socket;
}

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("IMAP handler per-session drain serialization", () => {
  it("emits every tagged completion across N separate data events (drain re-entrance safe)", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);

    // 25 commands, each in its own `data` event. Under the pre-fix
    // async handler this would spawn 25 concurrent processing loops
    // racing on the shared buffer; under the fix each fires drainCommands
    // which self-serializes via the `draining` guard.
    const n = 25;
    for (let i = 1; i <= n; i++) {
      socket.emit("data", Buffer.from(`t${i} NOOP\r\n`));
    }

    await waitFor(
      () => socket.writes.filter((w) => w.includes("OK NOOP completed")).length >= n,
      2000
    );

    const oks = socket.writes.filter((w) => w.includes("OK NOOP completed"));
    expect(oks.length).toBe(n);
  });

  it("preserves command order across pipelined + separate-segment inputs", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);

    // Interleave shapes the client actually produces: burst-of-3 pipelined
    // in one segment, then two more one-per-segment, then a burst of 5.
    socket.emit("data", Buffer.from("a1 NOOP\r\na2 NOOP\r\na3 NOOP\r\n"));
    socket.emit("data", Buffer.from("a4 NOOP\r\n"));
    socket.emit("data", Buffer.from("a5 NOOP\r\n"));
    socket.emit(
      "data",
      Buffer.from("a6 NOOP\r\na7 NOOP\r\na8 NOOP\r\na9 NOOP\r\na10 NOOP\r\n")
    );

    await waitFor(
      () => socket.writes.filter((w) => w.includes("OK NOOP completed")).length >= 10,
      2000
    );

    // Extract the tag from each OK response and confirm strict ascending
    // order — no interleaving, no reordering across the drain boundary.
    const tagOrder = socket.writes
      .map((w) => /^(a\d+) OK NOOP completed/.exec(w)?.[1])
      .filter((t): t is string => Boolean(t));
    expect(tagOrder).toEqual([
      "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10",
    ]);
  });

  it("recovers a partial line split across two data events", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);

    // Command arrives across three TCP segments — the drain must wait for
    // \r\n before dispatching, but the drain re-entrance from each segment
    // must not process partial input as a broken command.
    socket.emit("data", Buffer.from("b1 NO"));
    socket.emit("data", Buffer.from("OP"));
    socket.emit("data", Buffer.from("\r\n"));

    await waitFor(
      () => socket.writes.some((w) => w.includes("b1 OK NOOP completed")),
      1000
    );

    const oks = socket.writes.filter((w) => w.includes("b1 OK NOOP completed"));
    expect(oks.length).toBe(1);
    const bads = socket.writes.filter((w) => /^b1 BAD/.test(w));
    expect(bads.length).toBe(0);
  });
});
