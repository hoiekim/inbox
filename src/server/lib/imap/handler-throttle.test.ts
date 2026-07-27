/**
 * Command-burst pacing tests (throttler backpressure).
 *
 * RFC 3501 §7 requires a tagged completion for every command, and clients
 * pipeline aggressively during folder sync — iOS Mail sends STATUS for every
 * mailbox in one burst after LIST. Bursts beyond the per-second budget must
 * therefore be paced into later windows with each command still answered,
 * never refused or discarded.
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

    // No command may be refused with an untagged busy response.
    const dropped = socket.writes.filter((w) => w.includes("TEMPORARY UNAVAILABLE"));
    expect(dropped.length).toBe(0);
  }, 10000);

  it("stops pacing when the socket is destroyed mid-wait", async () => {
    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);
    const session = (
      handler as unknown as {
        session: { waitForCommandSlot: () => Promise<void> };
      }
    ).session;

    // Exhaust the per-second budget so the next slot requires waiting out
    // the window.
    for (let i = 0; i < 100; i++) {
      await session.waitForCommandSlot();
    }

    socket.destroyed = true;
    const start = Date.now();
    await session.waitForCommandSlot();
    // Must bail immediately instead of waiting out the ~1s window.
    expect(Date.now() - start).toBeLessThan(500);
  });
});
