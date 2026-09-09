/**
 * A final untagged `BYE` has to survive the socket it is written to.
 *
 * The teardown paths wrote the `BYE` and destroyed the socket in the next
 * statement. `socket.write` returns false once the write queue passes its
 * high-water mark, and `socket.destroy` discards everything still queued — so
 * the `BYE` reached the wire only when the queue happened to be short. The
 * conditions these teardowns fire in are exactly the ones that make it long: a
 * session torn down for over-buffering is a session whose peer stopped
 * reading. RFC 3501 §7.1.5's untagged response is what tells a client the
 * disconnect was the server's decision and not a network fault.
 *
 * These run over real TCP with a real handler. The mock sockets the other
 * handler suites use return `true` from every `write` and no-op their `end`,
 * which is precisely why they cannot see this defect — only a real socket
 * carrying a real write queue puts the invariant under test.
 */

import { describe, it, expect } from "bun:test";
import net from "net";
import "../push";
import { ImapRequestHandler } from "./handler";
import { idleManager } from "./idle-manager";

const FILL = "* 1 FETCH (BODY[] {1000}\r\n" + "x".repeat(1000) + ")\r\n";
const MAX_FILL_WRITES = 20000;
// Mirrors `CLOSE_FLUSH_TIMEOUT_MS` in session.ts.
const CLOSE_FLUSH_TIMEOUT_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SessionOf = { write: (data: string) => boolean };
const sessionOf = (handler: ImapRequestHandler) =>
  (handler as unknown as { session: SessionOf }).session;

/**
 * Write through the production path until the socket reports its high-water
 * mark reached. Returns false if backpressure was never reached, which makes
 * the fixture non-discriminating rather than merely failing.
 */
const fillPastHighWaterMark = (session: SessionOf) => {
  for (let i = 0; i < MAX_FILL_WRITES; i++) {
    if (!session.write(FILL)) return true;
  }
  return false;
};

interface Trip {
  received: string;
  closed: boolean;
  closedAfterMs: number;
  backpressureReached: boolean;
  dataListenersAfterTeardown: number;
  destroyedAtProbe: boolean | null;
}

/**
 * Stand up a real IMAP handler on a real socket, run `driveServer` once the
 * peer is attached, then read whatever actually crossed the wire.
 */
const trip = async (options: {
  peerReads: boolean;
  /** Start reading only after `settleMs`, once the teardown has happened. */
  peerReadsEventually?: boolean;
  prefill: boolean;
  clientSends?: string;
  /** Register the session as IDLE and run the shutdown sweep over it. */
  shutdownIdleSweep?: boolean;
  /** Fire the socket's own `timeout` event, as node does at SOCKET_TIMEOUT_MS. */
  emitTimeout?: boolean;
  followUp?: string;
  settleMs?: number;
  /** Probe `socket.destroyed` server-side this long after the teardown. */
  probeDestroyedAfterMs?: number;
}): Promise<Trip> => {
  const result: Trip = {
    received: "",
    closed: false,
    closedAfterMs: -1,
    backpressureReached: false,
    dataListenersAfterTeardown: -1,
    destroyedAtProbe: null,
  };

  let probeDone = Promise.resolve();
  await new Promise<void>((resolve) => {
    const server = net.createServer(async (socket) => {
      const handler = new ImapRequestHandler();
      handler.setSocket(socket);

      if (options.prefill) {
        result.backpressureReached = fillPastHighWaterMark(sessionOf(handler));
      }

      if (options.clientSends) {
        socket.emit("data", Buffer.from(options.clientSends));
      }
      if (options.emitTimeout) socket.emit("timeout");
      if (options.shutdownIdleSweep) {
        idleManager.shutdown();
        idleManager.addIdleSession(
          "close-flush-sweep",
          sessionOf(handler) as unknown as Parameters<
            typeof idleManager.addIdleSession
          >[1],
          "t1",
          "INBOX",
          "alice"
        );
        idleManager.shutdown();
      }
      // Armed before the first await so the client side cannot read `probeDone`
      // while it is still the resolved placeholder.
      if (options.probeDestroyedAfterMs !== undefined) {
        probeDone = sleep(options.probeDestroyedAfterMs).then(() => {
          result.destroyedAtProbe = socket.destroyed;
        });
      }

      await sleep(150);
      result.dataListenersAfterTeardown = socket.listenerCount("data");
      if (options.followUp) socket.emit("data", Buffer.from(options.followUp));
    });

    server.listen(0, "127.0.0.1", async () => {
      const port = (server.address() as net.AddressInfo).port;
      const startedAt = Date.now();
      const client = net.connect(port, "127.0.0.1", () => {
        if (!options.peerReads) client.pause();
      });

      let received = Buffer.alloc(0);
      client.on("data", (d) => {
        received = Buffer.concat([received, d as Uint8Array]);
      });
      client.on("close", () => {
        if (!result.closed) {
          result.closed = true;
          result.closedAfterMs = Date.now() - startedAt;
        }
      });

      await sleep(options.settleMs ?? 700);
      await probeDone;
      if (options.peerReadsEventually) {
        // Only now drain whatever the kernel held — the server has already
        // made its teardown decision.
        client.resume();
        await sleep(1200);
      }

      result.received = received.toString("utf8");
      server.close();
      client.destroy();
      resolve();
    });
  });

  return result;
};

describe("ImapSession.close — a final BYE survives a backpressured socket", () => {
  it("delivers BYE when the literal ceiling closes a session whose peer stopped reading", async () => {
    const outcome = await trip({
      peerReads: false,
      peerReadsEventually: true,
      prefill: true,
      clientSends: "A1 APPEND INBOX {999999999+}\r\n",
    });

    // Without this the fixture proves nothing: it would be asserting that a
    // BYE survives a queue that was never full.
    expect(outcome.backpressureReached).toBe(true);
    expect(outcome.received).toContain("* BYE Command too long\r\n");
    expect(outcome.closed).toBe(true);
  }, 20000);

  it("delivers BYE when the chained-literal cap closes the session", async () => {
    const chain = "A1 APPEND INBOX " + "{10+}\r\n0123456789".repeat(80) + "\r\n";
    const outcome = await trip({
      peerReads: false,
      peerReadsEventually: true,
      prefill: true,
      clientSends: chain,
    });

    expect(outcome.backpressureReached).toBe(true);
    expect(outcome.received).toContain("* BYE Command too long\r\n");
    expect(outcome.closed).toBe(true);
  }, 20000);

  it("stops reading the socket the moment it tears the session down", async () => {
    const outcome = await trip({
      peerReads: false,
      prefill: true,
      peerReadsEventually: true,
      clientSends: "A1 APPEND INBOX {999999999+}\r\n",
      followUp: "A2 CAPABILITY\r\n",
    });

    expect(outcome.dataListenersAfterTeardown).toBe(0);
    const afterBye = outcome.received.split("* BYE Command too long\r\n")[1] ?? "";
    expect(afterBye).not.toContain("CAPABILITY");
  }, 20000);

  it("destroys a peer that never reads rather than waiting on it forever", async () => {
    // `end` only promises the FIN goes out once the queue drains, and this
    // peer never drains it. The grace timer is the whole reason a teardown
    // still bounds the connection.
    const outcome = await trip({
      peerReads: false,
      prefill: true,
      clientSends: "A1 APPEND INBOX {999999999+}\r\n",
      probeDestroyedAfterMs: CLOSE_FLUSH_TIMEOUT_MS + 600,
      settleMs: 100,
    });

    expect(outcome.backpressureReached).toBe(true);
    expect(outcome.destroyedAtProbe).toBe(true);
  }, 20000);

  it("delivers BYE when the socket timeout fires on a backpressured session", async () => {
    // SOCKET_TIMEOUT_MS is five minutes; node's own `timeout` event is what
    // the handler listens for, so firing it is the whole trigger.
    const outcome = await trip({
      peerReads: false,
      peerReadsEventually: true,
      prefill: true,
      emitTimeout: true,
    });

    expect(outcome.backpressureReached).toBe(true);
    expect(outcome.received).toContain("* BYE Timeout\r\n");
  }, 20000);

  it("destroys a LOGOUT whose peer never reads its BYE", async () => {
    // `end` alone leaves this socket open for as long as the peer declines to
    // drain the queue the tagged OK is sitting behind.
    const outcome = await trip({
      peerReads: false,
      prefill: true,
      clientSends: "A1 LOGOUT\r\n",
      probeDestroyedAfterMs: CLOSE_FLUSH_TIMEOUT_MS + 600,
      settleMs: 100,
    });

    expect(outcome.backpressureReached).toBe(true);
    expect(outcome.destroyedAtProbe).toBe(true);
  }, 20000);

  it("delivers BYE and closes when the shutdown sweep drains IDLE sessions", async () => {
    const outcome = await trip({
      peerReads: false,
      prefill: true,
      shutdownIdleSweep: true,
      probeDestroyedAfterMs: CLOSE_FLUSH_TIMEOUT_MS + 600,
      settleMs: 100,
    });

    expect(outcome.backpressureReached).toBe(true);
    // The sweep says BYE on sockets it then has to stop holding: `server.close`
    // in the shutdown sequence waits on every live connection.
    expect(outcome.destroyedAtProbe).toBe(true);
  }, 20000);

  it("closes a LOGOUT promptly instead of lingering out the flush grace", async () => {
    const outcome = await trip({
      peerReads: true,
      prefill: false,
      peerReadsEventually: true,
      clientSends: "A1 LOGOUT\r\n",
      settleMs: 400,
    });

    expect(outcome.received).toContain("* BYE IMAP4rev1 Server logging out\r\n");
    expect(outcome.received).toContain("A1 OK LOGOUT completed\r\n");
    expect(outcome.closed).toBe(true);
    // The grace period is 2000ms; a well-behaved client must not pay it.
    expect(outcome.closedAfterMs).toBeLessThan(1000);
  }, 20000);
});
