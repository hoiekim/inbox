import { Socket } from "net";

/**
 * Grace period for a final response to reach the wire before the socket is
 * destroyed. Generous for a peer that is merely slow, short enough that a peer
 * which has stopped reading cannot hold the connection — and short enough to
 * fit inside the shutdown budget `start.ts` closes the IMAP servers under.
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 2000;

/**
 * Close an IMAP connection, letting everything already written reach the wire.
 *
 * This is the single teardown primitive for the protocol: `ImapSession.close`
 * delegates to it, and the auth rate-limit refusals in `auth.ts` — which hold
 * a bare socket rather than a session — call it directly.
 *
 * `socket.destroy()` drops whatever is still queued, and a final response is
 * written on exactly the peers likeliest to discard it: a socket torn down for
 * over-buffering is past its high-water mark by definition, and a peer refused
 * for repeated auth failure has no reason to still be reading. RFC 3501
 * §7.1.5's untagged `BYE` is what marks the disconnect as the server's
 * decision rather than a network fault, which is the difference between a
 * client that stops retrying and one that reconnects immediately.
 *
 * `end` flushes the write queue ahead of the FIN; the timer is what stops a
 * peer that never reads from holding the socket open on the strength of that
 * promise. Dropping the reader first is load-bearing: `end` half-closes the
 * write side only, so without it a peer being torn down for abuse keeps
 * feeding the parser for the whole flush window — and keeps resetting the
 * inactivity timeout that would otherwise reclaim the socket.
 */
export const closeSocket = (socket: Socket) => {
  if (socket.destroyed) return;

  socket.removeAllListeners("data");

  // Armed before the `end` that can satisfy it: a socket with an empty write
  // queue closes synchronously, and the timer has to be clearable by then.
  const timer = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, CLOSE_FLUSH_TIMEOUT_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));

  socket.end();
};
