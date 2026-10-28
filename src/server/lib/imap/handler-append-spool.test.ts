/**
 * An APPEND message literal is written to disk as it arrives rather than held
 * in the session buffer, and the file is removed on every way a command can
 * end — dispatched, refused, or abandoned by a closing socket.
 */

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { EventEmitter } from "events";
import fs from "fs";
import "../push";
import { ImapRequestHandler } from "./handler";
import { SessionBuffer } from "./session-buffer";
import { shutdownImapSessions } from "./session-registry";
import { ImapRequest } from "./types";
import { INCOMING_ATTACHMENT_FOLDER } from "server";

function makeMockSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    writes: string[];
    writable: boolean;
    destroyed: boolean;
    paused: boolean;
    write: (data: string) => boolean;
    setTimeout: () => void;
    destroy: () => void;
    end: () => void;
    pause: () => void;
    resume: () => void;
  };
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
  socket.paused = false;
  socket.pause = () => {
    socket.paused = true;
  };
  socket.resume = () => {
    socket.paused = false;
  };
  socket.write = (data: string) => {
    socket.writes.push(data);
    return true;
  };
  socket.setTimeout = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  socket.end = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
}

type Dispatched = { tag: string; request: ImapRequest; message?: Buffer };

/**
 * `onRequest` stands in for the session: it runs with the spooled file still
 * in place and decides how the command ends. `realDispatch` hands the command
 * to the real session instead.
 */
function makeHarness({
  authenticated = true,
  onRequest,
  realDispatch = false
}: {
  authenticated?: boolean;
  onRequest?: (tag: string, request: ImapRequest, socket: MockSocket) => Promise<void>;
  realDispatch?: boolean;
} = {}) {
  const handler = new ImapRequestHandler();
  const socket = makeMockSocket();
  const dispatched: Dispatched[] = [];
  const dispatch = handler.handleRequest.bind(handler);
  handler.handleRequest = async (tag, request) => {
    dispatched.push({
      tag,
      request,
      message:
        request.type === "APPEND" ? fs.readFileSync(request.data.message.path) : undefined
    });
    if (realDispatch) await dispatch(tag, request);
    if (onRequest) await onRequest(tag, request, socket);
  };
  handler.setSocket(socket as never);
  if (authenticated) {
    (handler as unknown as { session: { authenticated: boolean } }).session.authenticated = true;
  }
  return { socket, dispatched };
}

type MockSocket = ReturnType<typeof makeMockSocket>;

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

const spoolDirs = (): string[] =>
  fs.existsSync(INCOMING_ATTACHMENT_FOLDER) ? fs.readdirSync(INCOMING_ATTACHMENT_FOLDER) : [];

/** Feeds `data` in `segment`-sized pieces, holding off while the socket is paused. */
const pump = async (socket: MockSocket, data: Buffer, segment = 64 * 1024) => {
  for (let offset = 0; offset < data.length; ) {
    if (socket.destroyed) return;
    if (socket.paused) {
      await new Promise((r) => setTimeout(r, 1));
      continue;
    }
    socket.emit("data", data.subarray(offset, offset + segment));
    offset += segment;
    await new Promise((r) => setImmediate(r));
  }
};

const before = new Set<string>();
const newSpoolDirs = () => spoolDirs().filter((dir) => !before.has(dir));

const snapshot = () => {
  before.clear();
  for (const dir of spoolDirs()) before.add(dir);
};

afterEach(async () => {
  await settle();
  expect(newSpoolDirs()).toEqual([]);
});

describe("IMAP APPEND literal spool", () => {
  it("writes the message to a file as it arrives instead of buffering it", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();
    const message = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < message.length; i++) message[i] = i % 251;

    let peakBuffered = 0;
    const push = SessionBuffer.prototype.push;
    const pushed = spyOn(SessionBuffer.prototype, "push").mockImplementation(function (
      this: SessionBuffer,
      segment: Buffer
    ) {
      push.call(this, segment);
      peakBuffered = Math.max(peakBuffered, this.length);
    });
    try {
      socket.emit("data", Buffer.from(`a1 APPEND INBOX {${message.length}+}\r\n`));
      await settle();
      await pump(socket, message);
      socket.emit("data", Buffer.from("\r\n"));
      await settle();
    } finally {
      pushed.mockRestore();
    }

    expect(dispatched).toHaveLength(1);
    const [{ request, message: received }] = dispatched;
    if (request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(request.data.message.size).toBe(message.length);
    expect(Buffer.compare(received!, message)).toBe(0);
    // A few segments past the unread-text bound, not the 4 MiB message.
    expect(peakBuffered).toBeLessThan(256 * 1024);
    expect(socket.destroyed).toBe(false);
  });

  it("keeps octets that are not valid UTF-8 intact", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();
    const message = Buffer.from([0x53, 0x3a, 0x20, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x0d, 0x0a, 0xc3]);

    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${message.length}+}\r\n`));
    socket.emit("data", Buffer.concat([message, Buffer.from("\r\n")]));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(Buffer.compare(dispatched[0].message!, message)).toBe(0);
  });

  it("spools only the message, not a mailbox name sent as a literal", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND {6+}\r\nDrafts {5+}\r\nhello\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    const [{ request, message }] = dispatched;
    if (request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(request.data.mailbox).toBe("Drafts");
    expect(message!.toString()).toBe("hello");
  });

  it("grants a synchronizing literal its continuation and serves the command behind it", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX (\\Seen) {5}\r\n"));
    await settle();
    expect(socket.writes).toEqual(["+ go ahead\r\n"]);

    socket.emit("data", Buffer.from("hello\r\na2 NOOP\r\n"));
    await settle();

    expect(dispatched.map((d) => d.tag)).toEqual(["a1", "a2"]);
    expect(dispatched[0].message!.toString()).toBe("hello");
  });

  it("removes the file once the command completes", async () => {
    snapshot();
    let duringDispatch: string[] = [];
    const { socket } = makeHarness({
      onRequest: async (tag, _request, s) => {
        duringDispatch = newSpoolDirs();
        s.write(`${tag} OK [APPENDUID 1 1] APPEND completed\r\n`);
      }
    });

    socket.emit("data", Buffer.from("a1 APPEND INBOX {5+}\r\nhello\r\n"));
    await settle();

    expect(duringDispatch).toHaveLength(1);
    expect(socket.writes).toEqual(["a1 OK [APPENDUID 1 1] APPEND completed\r\n"]);
  });

  it("removes the file when the command is answered NO [TRYCREATE]", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness({
      onRequest: async (tag, _request, s) => {
        s.write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      }
    });

    socket.emit("data", Buffer.from("a1 APPEND Nowhere {5+}\r\nhello\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(socket.writes).toEqual(["a1 NO [TRYCREATE] Mailbox does not exist\r\n"]);
  });

  it("removes the file when storing the message throws", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness({
      onRequest: async () => {
        throw new Error("store failed");
      }
    });

    socket.emit("data", Buffer.from("a1 APPEND INBOX {5+}\r\nhello\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(socket.writes).toEqual(["a1 BAD Internal server error\r\n"]);
  });

  it("removes the file when an unauthenticated session is answered NO", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness({ authenticated: false, realDispatch: true });

    socket.emit("data", Buffer.from("a1 APPEND INBOX {5+}\r\nhello\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(socket.writes).toEqual(["a1 NO Not authenticated.\r\n"]);
  });

  it("removes the file when the command is refused before dispatch", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    // A tag past the ceiling parses but has no answerable completion.
    socket.emit("data", Buffer.from(`${"t".repeat(200)} APPEND INBOX {5+}\r\nhello\r\n`));
    await settle();

    expect(dispatched).toEqual([]);
    expect(socket.writes).toEqual(["* BAD Command tag too long\r\n"]);
  });

  it("creates no file for a refused declaration", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${35 * 1024 * 1024 + 1}}\r\n`));
    await settle();

    expect(socket.writes).toEqual([
      `a1 NO [TOOBIG] Literal exceeds ${35 * 1024 * 1024} octets\r\n`
    ]);
    expect(dispatched).toEqual([]);
  });

  it("removes a spooled message when a later literal of the same command is refused", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX {5+}\r\nhello {4000000000}\r\n"));
    await settle();

    expect(socket.writes).toHaveLength(1);
    expect(socket.writes[0]).toMatch(/^a1 NO \[TOOBIG\] /);
    expect(socket.destroyed).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("removes a spooled message when the chain ceiling ends the session", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    // One segment, so no link ever finds the buffer empty and dispatches early.
    socket.emit("data", Buffer.from("a1 APPEND INBOX {5+}\r\nhello" + " {1+}\r\nx".repeat(70)));
    await settle();

    expect(socket.writes).toEqual(["* BYE Command too long\r\n"]);
    expect(dispatched).toEqual([]);
  });

  it("removes a partial file when the client disconnects mid-literal", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX {1048576+}\r\n"));
    socket.emit("data", Buffer.alloc(300 * 1024, 0x61));
    await settle();
    expect(newSpoolDirs()).toHaveLength(1);

    socket.emit("close");
    await settle();

    expect(dispatched).toEqual([]);
  });

  it("removes a partial file when the socket closes while a write is pending", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX {1048576+}\r\n"));
    socket.emit("data", Buffer.alloc(64 * 1024, 0x61));
    socket.emit("close");
    await settle();

    expect(dispatched).toEqual([]);
  });

  it("removes a complete message still waiting for its command's tail", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    // The payload is in, but the line that ends the command never arrives.
    socket.emit("data", Buffer.from("a1 APPEND INBOX {5+}\r\nhello "));
    await settle();
    expect(newSpoolDirs()).toHaveLength(1);

    socket.emit("close");
    await settle();

    expect(dispatched).toEqual([]);
  });

  it("removes a partial file when the server shuts down", async () => {
    snapshot();
    const { socket, dispatched } = makeHarness();

    socket.emit("data", Buffer.from("a1 APPEND INBOX {1048576+}\r\n"));
    socket.emit("data", Buffer.alloc(100 * 1024, 0x61));
    await settle();
    expect(newSpoolDirs()).toHaveLength(1);

    shutdownImapSessions();
    await settle();

    expect(socket.destroyed).toBe(true);
    expect(dispatched).toEqual([]);
  });
});
