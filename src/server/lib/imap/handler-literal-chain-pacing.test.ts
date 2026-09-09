/**
 * Pacing and accumulation cost of a chained literal command.
 *
 * A literal-bearing command spans several lines, and only its header line
 * reaches `waitForCommandSlot()`. Every declaration after that one — RFC 3501
 * §4.3 permits a literal wherever an astring is legal, so LOGIN chains one per
 * credential — draws a continuation, moves a payload through the session
 * buffer and re-enters the parser, all of it work the same octets cost a
 * pacing slot for when they arrive as a command of their own.
 *
 * The other half is what the octets cost to hold. The drain parks until a
 * declared payload is complete, so a copy taken per arriving segment is a copy
 * no read benefits from — quadratic in the segment count, on the shared event
 * loop, and reachable by ordinary traffic: a message-sized attachment is a
 * multi-MB APPEND.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "events";
// See handler-idle.test.ts: import push first so the idle-manager ↔ push ↔
// server-barrel import cycle initializes in production order.
import "../push";
import { ImapRequestHandler } from "./handler";
import { ImapRequest } from "./types";

function makeMockSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    writes: string[];
    writable: boolean;
    destroyed: boolean;
    paused: boolean;
    write: (data: string) => boolean;
    setTimeout: () => void;
    pause: () => void;
    resume: () => void;
    destroy: () => void;
    end: () => void;
  };
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
  socket.paused = false;
  socket.write = (data: string) => {
    socket.writes.push(data);
    return true;
  };
  socket.setTimeout = () => {};
  socket.pause = () => {
    socket.paused = true;
  };
  socket.resume = () => {
    socket.paused = false;
  };
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.end = () => {};
  return socket;
}

function makeHarness(authenticated = false) {
  const handler = new ImapRequestHandler();
  const socket = makeMockSocket();
  const dispatched: { tag: string; request: ImapRequest }[] = [];
  handler.handleRequest = async (tag, request) => {
    dispatched.push({ tag, request });
  };
  handler.setSocket(socket as never);
  const session = (
    handler as unknown as {
      session: {
        authenticated: boolean;
        waitForCommandSlot: () => Promise<void>;
      };
    }
  ).session;
  if (authenticated) session.authenticated = true;
  const paced = spyOn(session, "waitForCommandSlot");
  return { socket, dispatched, paced };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("IMAP chained literal pacing", () => {
  it("charges a slot for the chained declaration, not only the header line", async () => {
    const { socket, dispatched, paced } = makeHarness();

    socket.emit("data", Buffer.from("A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n"));
    await settle();

    // Header line, then the tail declaring the password. Unpaced, the second
    // one is free.
    expect(paced).toHaveBeenCalledTimes(2);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toMatchObject({
      type: "LOGIN",
      data: { username: "admin", password: "password" }
    });
  });

  it("charges a slot per link across a long chain", async () => {
    const { socket, paced } = makeHarness();

    // SEARCH takes an unbounded key list, so its chain is the one a peer can
    // extend at will — and the one the ceilings alone leave unpaced.
    const links = 30;
    socket.emit(
      "data",
      Buffer.from(`A1 SEARCH SUBJECT {1+}\r\nx${" FROM {1+}\r\nx".repeat(links)}\r\n`)
    );
    await settle();

    expect(paced).toHaveBeenCalledTimes(links + 1);
  });

  it("leaves an unchained command charged exactly once", async () => {
    const { socket, dispatched, paced } = makeHarness();

    // The completing tail of a single-literal command dispatches the command
    // its own header line already paid for; charging it again would double the
    // cost of every APPEND.
    socket.emit("data", Buffer.from("A1 SELECT {5+}\r\nINBOX\r\n"));
    await settle();

    expect(paced).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
  });

  it("holds a segmented literal without copying it once per segment", async () => {
    const { socket, dispatched } = makeHarness(true);

    const payload = 2 * 1024 * 1024;
    const segment = Buffer.alloc(64 * 1024, 0x41);
    const segments = payload / segment.length;
    // The client counts the message's own terminator into `{N}`, so the last
    // two octets complete the literal rather than tailing it.
    const declared = payload + 2;

    socket.emit("data", Buffer.from(`A1 APPEND INBOX {${declared}+}\r\n`));
    await settle();

    const copied = spyOn(Buffer, "concat");
    try {
      // `data` is synchronous and the drain is not, so these all land before a
      // read can consume any of them — the same window a real socket's segments
      // ride on while the drain parks waiting for the payload to complete.
      for (let i = 0; i < segments; i++) socket.emit("data", segment);
      const bytes = (
        copied.mock.calls as unknown as [Uint8Array[], number][]
      ).reduce((total, [, length]) => total + length, 0);
      // Copying the buffer per segment moves ~`segments / 2` times the payload
      // before the drain can look at any of it.
      expect(bytes).toBeLessThan(payload);
    } finally {
      copied.mockRestore();
    }

    socket.emit("data", Buffer.from("\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toMatchObject({ type: "APPEND" });
    expect(
      (dispatched[0].request as { data: { message: string } }).data.message.length
    ).toBe(declared);
  });
});
