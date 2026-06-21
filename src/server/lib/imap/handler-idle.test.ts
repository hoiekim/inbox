/**
 * Tests for IMAP IDLE termination — handler.ts + session.ts (#546).
 *
 * Regression coverage: DONE must be detected by the handler's main line
 * buffer (which reassembles split TCP chunks and \r\n-delimited lines), not a
 * separate raw-socket listener that only matched when an entire chunk equalled
 * "DONE". The old listener left the session stranded in IDLE forever when:
 *   1. DONE was split across TCP chunks ("DO" then "NE\r\n"), or
 *   2. DONE was pipelined with the next command ("DONE\r\nA4 NOOP\r\n") — and
 *      the pipelined command was silently dropped.
 */

import { describe, it, expect, spyOn, beforeEach, afterAll } from "bun:test";
import { EventEmitter } from "events";
// idle-manager ↔ push ↔ server-barrel form a runtime import cycle: idle-manager
// imports the `server` barrel (for `logger`), which re-exports push.ts, whose
// top-level `createPush(realIdleManager)` needs the idleManager singleton.
// Importing push first forces the graph to initialize in production order so the
// singleton is constructed before we spy on it. (Same guard as idle-manager.test.ts.)
import "../push";
import { idleManager } from "./idle-manager";

// session.ts registers/unregisters IDLE sessions on the real `idleManager`
// singleton. Spy on just those two methods (restored in afterAll) rather than
// `mock.module`-ing the whole module: `mock.module` is process-global, and
// replacing `./idle-manager` with a partial `{ idleManager }` stub drops the
// singleton's other methods — notably `shutdown()` — which then breaks
// idle-manager.test.ts when it runs later in the same `bun test` process
// (TypeError: idleManager.shutdown is not a function). The previous
// spread-restore in afterAll did not reliably reinstate the binding for that
// sibling file. spyOn mutates the live singleton session.ts already holds and
// reverts cleanly via mockRestore.
const mockAddIdleSession = spyOn(idleManager, "addIdleSession").mockImplementation(
  () => {}
);
const mockRemoveIdleSession = spyOn(
  idleManager,
  "removeIdleSession"
).mockImplementation(() => {});

afterAll(() => {
  mockAddIdleSession.mockRestore();
  mockRemoveIdleSession.mockRestore();
});

import { ImapRequestHandler } from "./handler";

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

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

interface TestSession {
  authenticated: boolean;
  selectedMailbox: string | null;
  store: unknown;
  startIdle: (tag: string) => Promise<unknown>;
  isInIdleMode: () => boolean;
  endIdle: () => void;
}

async function makeIdlingSession() {
  const handler = new ImapRequestHandler();
  const socket = makeMockSocket();
  // setSocket expects a net.Socket; the mock implements the surface it uses.
  handler.setSocket(socket as never);
  const session = (handler as unknown as { session: TestSession }).session;
  // Drive the session straight into IDLE without a real DB-backed login.
  session.authenticated = true;
  session.selectedMailbox = "INBOX";
  session.store = {
    getUser: () => ({ id: "u1", username: "admin" }),
    countMessages: async () => null,
  };
  await session.startIdle("a3");
  return { handler, socket, session };
}

describe("IMAP IDLE DONE handling (#546)", () => {
  beforeEach(() => {
    mockAddIdleSession.mockClear();
    mockRemoveIdleSession.mockClear();
  });

  it("starts IDLE and emits the continuation response", async () => {
    const { socket, session } = await makeIdlingSession();
    expect(session.isInIdleMode()).toBe(true);
    expect(socket.writes.join("")).toContain("+ idling\r\n");
  });

  it("terminates IDLE on a single-write DONE (control case)", async () => {
    const { socket, session } = await makeIdlingSession();
    socket.emit("data", Buffer.from("DONE\r\n"));
    await flush();
    expect(session.isInIdleMode()).toBe(false);
    expect(socket.writes.join("")).toContain("a3 OK IDLE terminated\r\n");
  });

  it("terminates IDLE when DONE is split across TCP chunks", async () => {
    const { socket, session } = await makeIdlingSession();
    socket.emit("data", Buffer.from("DO"));
    socket.emit("data", Buffer.from("NE\r\n"));
    await flush();
    expect(session.isInIdleMode()).toBe(false);
    expect(socket.writes.join("")).toContain("a3 OK IDLE terminated\r\n");
  });

  it("terminates IDLE and processes a command pipelined after DONE", async () => {
    const { socket, session } = await makeIdlingSession();
    socket.emit("data", Buffer.from("DONE\r\na4 NOOP\r\n"));
    await flush();
    expect(session.isInIdleMode()).toBe(false);
    const out = socket.writes.join("");
    expect(out).toContain("a3 OK IDLE terminated\r\n");
    // The pipelined NOOP must not be dropped — it gets a tagged response.
    expect(out).toContain("a4 OK NOOP completed\r\n");
  });

  it("ignores non-DONE input during IDLE without terminating", async () => {
    const { socket, session } = await makeIdlingSession();
    socket.emit("data", Buffer.from("a5 NOOP\r\n"));
    await flush();
    expect(session.isInIdleMode()).toBe(true);
    expect(socket.writes.join("")).not.toContain("a5 OK NOOP completed");
  });
});
