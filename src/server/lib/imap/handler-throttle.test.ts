/**
 * Regression tests for command-burst handling (throttler backpressure).
 *
 * The per-connection throttler used to DROP over-limit commands: it wrote an
 * untagged `* NO [TEMPORARY UNAVAILABLE]` and never executed the command, so
 * the client never received a tagged completion (RFC 3501 §7 violation).
 * Clients that pipeline aggressively during folder sync — iOS Mail sends
 * STATUS for every mailbox in one burst after LIST — hung waiting for tags
 * that never arrived and displayed every mailbox as empty.
 *
 * The fix paces over-limit bursts (waitForCommandSlot) instead of dropping
 * them: every pipelined command must eventually get its tagged response.
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "events";
// See handler-idle.test.ts: import push first so the idle-manager ↔ push ↔
// server-barrel import cycle initializes in production order.
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("IMAP handler command bursts", () => {
  it("answers every command in a burst within the rate budget", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);

    const burst = Array.from({ length: 30 }, (_, i) => `t${i + 1} NOOP\r\n`).join("");
    socket.emit("data", Buffer.from(burst));

    await waitFor(
      () => socket.writes.filter((w) => w.includes("OK NOOP completed")).length >= 30,
      1000
    );

    const okCount = socket.writes.filter((w) => w.includes("OK NOOP completed")).length;
    expect(okCount).toBe(30);
  });

  it("paces (not drops) bursts beyond the per-second limit — every command gets a tagged completion", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);

    // 150 pipelined commands exceeds the 100/sec budget; the overflow must be
    // delayed into the next window, never discarded.
    const total = 150;
    const burst = Array.from({ length: total }, (_, i) => `t${i + 1} NOOP\r\n`).join("");
    socket.emit("data", Buffer.from(burst));

    await waitFor(
      () =>
        socket.writes.filter((w) => w.includes("OK NOOP completed")).length >= total,
      4000
    );

    for (let i = 1; i <= total; i++) {
      const answered = socket.writes.some((w) => w.startsWith(`t${i} OK`));
      expect(answered).toBe(true);
    }

    // The drop-path response must be gone for good.
    const dropped = socket.writes.filter((w) => w.includes("TEMPORARY UNAVAILABLE"));
    expect(dropped.length).toBe(0);
  }, 10000);
});
