/**
 * Shutdown has to end IMAP connections, not just stop accepting them.
 *
 * `Server.close` only stops the listener: its callback waits for every open
 * connection to end, and an idle IMAP client ends only when SOCKET_TIMEOUT_MS
 * (five minutes) reclaims it. SIGTERM awaited that callback, so one idle
 * client held the process far past compose's 10s stop grace and the pool drain
 * after it never ran.
 *
 * Real TCP and the production listener, like session-close-flush.test.ts: the
 * defect is in when a real server's `close` callback fires, which no fake
 * socket can show.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import net from "net";
import "../push";
import { ImapRequestHandler } from "./handler";
import { idleManager } from "./idle-manager";
import { CLOSE_FLUSH_TIMEOUT_MS } from "./close-socket";
import {
  closeImapServers,
  getImapListener,
  IMAP_SHUTDOWN_TIMEOUT_MS,
} from "./index";
import {
  _resetConnectedSessions,
  getConnectedSessionCount,
  shutdownImapSessions,
} from "./session-registry";

const BYE = "* BYE Server shutting down\r\n";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) await sleep(10);
};

const countOf = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

/** Listen on an ephemeral loopback port, keeping the server-side sockets. */
const listen = async (listener: (socket: net.Socket) => void) => {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    listener(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
};

/**
 * Connect and wait for the first line, so the server-side session exists
 * before the test moves on. `allowHalfOpen` keeps the client's side open after
 * the server's FIN — a peer that never closes on its own.
 */
const connect = async (
  port: number,
  { allowHalfOpen = false, awaitGreeting = true } = {}
) => {
  let received = "";
  let closed = false;
  const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen });
  sockets.push(socket);
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    received += data;
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
  });
  if (awaitGreeting) await waitFor(() => received.includes("\r\n"), 2000);
  else await new Promise<void>((resolve) => socket.once("connect", resolve));
  return { received: () => received, closed: () => closed };
};

const timed = async <T>(step: Promise<T>) => {
  const startedAt = Date.now();
  const result = await step;
  return { result, elapsedMs: Date.now() - startedAt };
};

beforeEach(() => {
  // Other suites attach fake sockets that never close; the sweep is
  // process-wide and must only reach what this file opened.
  _resetConnectedSessions();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  idleManager.shutdown();
});

describe("IMAP shutdown over real TCP", () => {
  it("tells an idle pre-auth client BYE and closes the listener promptly", async () => {
    const { server, port } = await listen(getImapListener(false));
    const client = await connect(port);
    expect(client.received()).toStartWith("* OK");
    expect(getConnectedSessionCount()).toBe(1);

    const { result: drained, elapsedMs } = await timed(closeImapServers([server]));

    // Without the sweep, the close callback waits out SOCKET_TIMEOUT_MS and
    // this comes back false at the bound instead.
    expect(drained).toBe(true);
    // A client that closes on FIN goes as soon as the BYE lands — no need to
    // wait out the flush window.
    expect(elapsedMs).toBeLessThan(CLOSE_FLUSH_TIMEOUT_MS);
    await waitFor(client.closed, 1000);
    expect(client.closed()).toBe(true);
    expect(client.received()).toEndWith(BYE);
    expect(getConnectedSessionCount()).toBe(0);
  });

  it("closes the listener within the flush window when the client keeps its side open", async () => {
    const { server, port } = await listen(getImapListener(false));
    const client = await connect(port, { allowHalfOpen: true });

    const { result: drained, elapsedMs } = await timed(closeImapServers([server]));

    expect(drained).toBe(true);
    // No lower bound: node holds the socket half-open until `closeSocket`'s
    // flush timer destroys it, bun closes it on `end` without waiting for the
    // peer. Either way it is gone inside the bound.
    expect(elapsedMs).toBeLessThan(IMAP_SHUTDOWN_TIMEOUT_MS);
    await waitFor(() => client.received().endsWith(BYE), 1000);
    expect(client.received()).toEndWith(BYE);
  });

  it("sends an IDLE session one BYE when the IDLE sweep has already closed it", async () => {
    // start.ts runs `idleManager.shutdown()` first, which says BYE to IDLE
    // sessions itself; the connection sweep must not say it a second time.
    let handler: ImapRequestHandler | null = null;
    const { server, port } = await listen((socket) => {
      handler = new ImapRequestHandler(false);
      handler.setSocket(socket);
      socket.write("* OK ready\r\n");
    });
    const client = await connect(port);
    const session = (handler as unknown as { session: unknown }).session;
    idleManager.addIdleSession(
      "shutdown-idle",
      session as Parameters<typeof idleManager.addIdleSession>[1],
      "t1",
      "INBOX",
      "alice"
    );

    idleManager.shutdown();
    const drained = await closeImapServers([server]);

    expect(drained).toBe(true);
    await waitFor(client.closed, 1000);
    expect(countOf(client.received(), "* BYE")).toBe(1);
  });

  it("stops waiting at the bound on a connection no session owns", async () => {
    // Stands in for an implicit-TLS handshake still in flight: the listener
    // counts the connection, but no handler has attached a session to it yet.
    const { server, port } = await listen(() => {});
    await connect(port, { awaitGreeting: false });
    await waitFor(() => sockets.length === 2, 1000);

    const { result: drained, elapsedMs } = await timed(closeImapServers([server]));

    expect(drained).toBe(false);
    expect(elapsedMs).toBeGreaterThanOrEqual(IMAP_SHUTDOWN_TIMEOUT_MS - 50);
    expect(elapsedMs).toBeLessThan(IMAP_SHUTDOWN_TIMEOUT_MS + 1000);
  });
});

/** Minimal duplex stand-in: records writes, closes on `end`. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  written: string[] = [];
  write(data: string) {
    this.written.push(data);
    return true;
  }
  end() {
    this.writable = false;
    this.writableEnded = true;
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
  setTimeout() {}
  pause() {}
  resume() {}
}

describe("IMAP shutdown sweep across a STARTTLS swap", () => {
  // `startTls` hands the handler a TLSSocket wrapping the cleartext one, and
  // strips the cleartext socket's `close` listener on the way — so the
  // cleartext session's own cleanup never runs.
  const upgrade = () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);
    plain.removeAllListeners("close");
    const secure = new FakeSocket();
    handler.setSocket(secure as never);
    return { plain, secure };
  };

  it("tracks only the upgraded session", () => {
    const { plain, secure } = upgrade();
    expect(getConnectedSessionCount()).toBe(1);

    expect(shutdownImapSessions()).toBe(1);

    expect(secure.written).toEqual([BYE]);
    expect(secure.destroyed).toBe(true);
    expect(plain.written).toEqual([]);
  });

  it("drops the upgraded session when its socket closes", () => {
    const { secure } = upgrade();
    secure.destroy();
    expect(getConnectedSessionCount()).toBe(0);
  });
});
