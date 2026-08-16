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

/**
 * One real turn of the event loop, for use BETWEEN `emit`s in a segmentation
 * test. Without it the test does not segment anything: `drainCommands` sets
 * `draining = true` and suspends at its first `await`, so every subsequent
 * synchronous `emit` only appends to `buffer` and returns — the buffer is whole
 * again before the drain resumes, and the test passes for the same reason a
 * single `emit` of the entire string would. Cheaper than `settle()` (which is
 * 10 timer hops) because a per-segment `settle()` would put seconds on a test
 * that emits byte by byte.
 */
const tick = () => new Promise((r) => setTimeout(r, 1));

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
      await tick();
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

  it("counts a literal in OCTETS, not UTF-16 code units", async () => {
    const { socket, dispatched } = makeHarness();

    // "pässword" is 8 code units and 9 OCTETS. A code-unit count takes 8
    // characters — the password loses its last letter and swallows the CR —
    // and the pipelined A2 never gets answered.
    const payload = Buffer.from("pässword", "utf8");
    expect(payload.length).toBe(9);
    socket.emit(
      "data",
      Buffer.concat([
        Buffer.from("A1 LOGIN {5+}\r\nadmin {9+}\r\n"),
        payload,
        Buffer.from("\r\nA2 NOOP\r\n"),
      ])
    );
    await settle();

    expect(dispatched.map((d) => d.tag)).toEqual(["A1", "A2"]);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "pässword" }
    });
  });

  it("reassembles a multi-byte character split across TCP segments", async () => {
    const { socket, dispatched } = makeHarness();

    const payload = Buffer.from("café", "utf8"); // 5 octets, 4 code units
    socket.emit("data", Buffer.from("A1 SELECT {5+}\r\n"));
    await tick();
    // Split mid-sequence: the trailing byte of "é" arrives separately. A
    // per-segment toString() would decode the halves to U+FFFD.
    socket.emit("data", payload.subarray(0, 4));
    await tick();
    socket.emit("data", Buffer.concat([payload.subarray(4), Buffer.from("\r\n")]));
    await settle();

    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "SELECT") throw new Error("Expected SELECT");
    expect(dispatched[0].request.data.mailbox).toBe("café");
  });

  it("carries an APPEND payload through byte-for-byte, trailing CRLF included", async () => {
    const { socket, dispatched } = makeHarness();

    const message = "Subject: x\r\n\r\nbody\r\n";
    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${Buffer.byteLength(message)}+}\r\n`));
    await tick();
    socket.emit("data", Buffer.concat([Buffer.from(message), Buffer.from("\r\n")]));
    await settle();

    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.message).toBe(message);
  });

  it("dispatches when the payload consumed its own terminator instead of wedging", async () => {
    const { socket, dispatched } = makeHarness();

    // The client counted the CRLF into {N} and sent nothing after it. Not
    // conforming, but it must not hold the session open with no tagged
    // completion until the socket timeout.
    socket.emit("data", Buffer.from("a1 APPEND INBOX {13+}\r\nHello World\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.message).toBe("Hello World\r\n");
  });

  it("accepts a zero-length literal", async () => {
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX {0+}\r\n\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.message).toBe("");
  });

  it("does not read a trailing {N} inside an argument as a literal declaration", async () => {
    const { socket, dispatched } = makeHarness();

    // `p@ss{5}` is a password that happens to end in brace-digits. Treating it
    // as a declaration emits a continuation and eats the pipelined A2 NOOP.
    socket.emit("data", Buffer.from("A1 LOGIN admin p@ss{5}\r\nA2 NOOP\r\n"));
    await settle();

    expect(dispatched.map((d) => d.tag)).toEqual(["A1", "A2"]);
    expect(socket.writes).toEqual([]);
  });

  it("waits for the rest of the line when a non-final payload is flushed on its own", async () => {
    const { socket, dispatched } = makeHarness();

    // The payload arrives in its own segment — what any client that issues a
    // separate write() for it produces, and what any payload ending on an MSS
    // boundary produces regardless of client. An empty buffer here means "no
    // more octets have arrived YET", not "the command is done": `admin` is not
    // the last argument, so the tail is still in flight. Dispatching on the
    // empty buffer answers A1 short and then reads ` "hunter2"` as a fresh
    // command line — which is #805 verbatim, in the fix for #805.
    socket.emit("data", Buffer.from("A1 LOGIN {5+}\r\n"));
    await tick();
    socket.emit("data", Buffer.from("admin"));
    await tick();
    expect(dispatched).toEqual([]);
    socket.emit("data", Buffer.from(' "hunter2"\r\n'));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "hunter2" }
    });
    expect(socket.writes).toEqual([]);
  });

  it("reassembles two literals when the first payload is flushed on its own", async () => {
    const { socket, dispatched } = makeHarness();

    for (const chunk of ["A1 LOGIN {5+}\r\n", "admin", " {8+}\r\n", "password\r\n"]) {
      socket.emit("data", Buffer.from(chunk));
      await tick();
    }
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "password" }
    });
    expect(socket.writes).toEqual([]);
  });

  it("emits exactly one continuation per synchronizing declaration, never on a {n} tag", async () => {
    const { socket, dispatched } = makeHarness();

    // A short dispatch here is worse on the wire than in the LITERAL+ case: the
    // server answers A1 and then emits a SECOND `+ go ahead` for what it thinks
    // is a new command, desynchronizing the client's response stream.
    for (const chunk of ["A1 LOGIN {5}\r\n", "admin", " {8}\r\n", "password\r\n"]) {
      socket.emit("data", Buffer.from(chunk));
      await tick();
    }
    await settle();

    expect(socket.writes).toEqual(["+ go ahead\r\n", "+ go ahead\r\n"]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].tag).toBe("A1");
  });

  it("reassembles a two-literal RENAME whose first payload is flushed on its own", async () => {
    const { socket, dispatched } = makeHarness();

    // Not a LOGIN-only shape: every command whose literal is not the final
    // argument is affected — RENAME, STATUS, SEARCH CHARSET, APPEND with a
    // literal mailbox.
    for (const chunk of ["A1 RENAME {5+}\r\n", "Oldie", " {5+}\r\n", "Newie\r\n"]) {
      socket.emit("data", Buffer.from(chunk));
      await tick();
    }
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "RENAME",
      data: { oldName: "Oldie", newName: "Newie" }
    });
    expect(socket.writes).toEqual([]);
  });

  it("keeps a final APPEND payload dispatching when its trailing CRLF arrives separately", async () => {
    const { socket, dispatched } = makeHarness();

    // The one shape that was accidentally safe before the gate — a final
    // literal whose payload lands alone. Keep it that way: the tail CRLF
    // completes the command on the next segment.
    const message = "Subject: x\r\n\r\nbody";
    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${Buffer.byteLength(message)}+}\r\n`));
    await tick();
    socket.emit("data", Buffer.from(message));
    await tick();
    socket.emit("data", Buffer.from("\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.message).toBe(message);
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

  it("redacts an untagged LOGIN, which only ever reaches the failure log", async () => {
    const debugSpy = spyOn(logger, "debug");
    try {
      const { socket } = makeHarness();
      debugSpy.mockClear();

      socket.emit("data", Buffer.from("LOGIN admin hunter2\r\n"));
      await settle();

      const logged = journal(debugSpy);
      expect(logged).not.toContain("hunter2");
      expect(logged).toContain("LOGIN [REDACTED]");
    } finally {
      debugSpy.mockRestore();
    }
  });
});
