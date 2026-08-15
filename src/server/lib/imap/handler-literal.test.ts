/**
 * Wire-level literal continuation (RFC 3501 §4.3, RFC 7888 LITERAL+).
 *
 * The drain loop used to CRLF-split the socket buffer with literal state for
 * APPEND only. Every other literal-bearing command therefore had its payload
 * lines parsed as commands of their own — and LOGIN carries its credentials in
 * exactly that position, so `A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n`
 * produced `admin BAD Invalid command` / `password BAD Invalid command` on the
 * wire and dropped both fragments into the parse-failure debug log
 * (hoiekim/inbox#805).
 *
 * These tests pin the invariants:
 *  1) A literal payload never becomes a command — one tagged response per
 *     command, on the command's own tag.
 *  2) The reassembled command reaches `handleRequest` with its octets intact,
 *     across TCP segmentation and both literal forms.
 *  3) No credential reaches the journal, literal or plain.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "events";
import "../push";
import { ImapRequestHandler } from "./handler";
import { ImapRequest } from "./types";
import { logger } from "server";

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

/**
 * Drive the handler without letting a parsed command reach the session (LOGIN
 * would open a DB connection). Returns the captured dispatches plus the socket
 * so the raw wire writes stay assertable.
 */
function makeHarness() {
  const handler = new ImapRequestHandler();
  const socket = makeMockSocket();
  const dispatched: { tag: string; request: ImapRequest }[] = [];
  handler.handleRequest = async (tag, request) => {
    dispatched.push({ tag, request });
  };
  handler.setSocket(socket as never);
  return { socket, dispatched };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("IMAP literal continuation", () => {
  it("reassembles a LITERAL+ LOGIN instead of parsing its credentials as commands", async () => {
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].tag).toBe("A1");
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "password" }
    });
    // A non-synchronizing literal needs no continuation prompt, and nothing
    // about this command is an error — the wire stays silent.
    expect(socket.writes).toEqual([]);
  });

  it("prompts once per synchronizing literal and still reassembles", async () => {
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("A1 LOGIN {5}\r\n"));
    await settle();
    expect(socket.writes).toEqual(["+ go ahead\r\n"]);

    socket.emit("data", Buffer.from("admin {8}\r\n"));
    await settle();
    expect(socket.writes).toEqual(["+ go ahead\r\n", "+ go ahead\r\n"]);

    socket.emit("data", Buffer.from("password\r\n"));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "password" }
    });
  });

  it("reassembles across arbitrary TCP segmentation", async () => {
    const { socket, dispatched } = makeHarness();

    for (const chunk of "A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\n".split("")) {
      socket.emit("data", Buffer.from(chunk));
    }
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "password" }
    });
    expect(socket.writes).toEqual([]);
  });

  it("keeps octets a quoted string could not carry", async () => {
    const { socket, dispatched } = makeHarness();

    // 12 octets: `p@ss "w\d {}` — quotes, a backslash, a brace, a space.
    socket.emit("data", Buffer.from('A1 LOGIN {5+}\r\nadmin {12+}\r\np@ss "w\\d {}\r\n'));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: 'p@ss "w\\d {}' }
    });
  });

  it("answers an unparseable literal command on its own tag, never on the payload", async () => {
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("A1 FOOBAR {5+}\r\nadmin\r\n"));
    await settle();

    expect(dispatched).toEqual([]);
    expect(socket.writes).toEqual(["A1 BAD Unknown command: FOOBAR\r\n"]);
  });

  it("still reassembles an APPEND literal", async () => {
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX (\\Seen) {11}\r\n"));
    await settle();
    expect(socket.writes).toEqual(["+ go ahead\r\n"]);

    socket.emit("data", Buffer.from("Hello World\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].tag).toBe("a1");
    expect(dispatched[0].request.type).toBe("APPEND");
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.mailbox).toBe("INBOX");
    expect(dispatched[0].request.data.message).toBe("Hello World");
  });

  it("processes a command pipelined behind a literal command", async () => {
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("A1 LOGIN {5+}\r\nadmin {8+}\r\npassword\r\nA2 NOOP\r\n"));
    await settle();

    expect(dispatched.map((d) => d.tag)).toEqual(["A1", "A2"]);
    expect(dispatched[1].request.type).toBe("NOOP");
  });
});

describe("IMAP credential logging", () => {
  const journal = (spy: ReturnType<typeof spyOn>) =>
    JSON.stringify(spy.mock.calls);

  it("never writes a literal credential to the journal", async () => {
    const debugSpy = spyOn(logger, "debug");
    try {
      const { socket } = makeHarness();
      debugSpy.mockClear();

      // Missing password: forces the parse-failure branch, which is the log
      // line the issue named.
      socket.emit("data", Buffer.from("A1 LOGIN {5+}\r\nadmin\r\n"));
      await settle();

      const logged = journal(debugSpy);
      expect(logged).not.toContain("admin");
      expect(logged).toContain("A1 LOGIN [REDACTED]");
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("never writes a plain-argument password to the journal", async () => {
    const debugSpy = spyOn(logger, "debug");
    try {
      const { socket } = makeHarness();
      debugSpy.mockClear();

      socket.emit("data", Buffer.from("A1 LOGIN admin hunter2\r\n"));
      await settle();

      const logged = journal(debugSpy);
      expect(logged).not.toContain("hunter2");
      expect(logged).toContain("A1 LOGIN [REDACTED]");
    } finally {
      debugSpy.mockRestore();
    }
  });
});
