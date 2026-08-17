/**
 * Commands pipelined into the same TCP segment as STARTTLS must not survive the
 * upgrade (RFC 2595 §2.1, CVE-2011-0411 class).
 *
 * `startTls` swaps the socket from inside the previous socket's command drain,
 * and that drain closes over its own cleartext `buffer`. Without the generation
 * check in `ImapRequestHandler`, the rest of the attacker-controlled segment
 * keeps being dispatched after the swap — and its responses go out on the
 * victim's now-encrypted channel, which is what makes the injected command
 * indistinguishable from one the victim sent.
 *
 * Driven through the real `setSocket` data path rather than a session method,
 * because the defect lives in the loop, not in `startTls`.
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "events";
import { ImapRequestHandler } from "./handler";

/** Minimal duplex stand-in: emits `data`, records what was written. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  written: string[] = [];
  write(data: string) {
    this.written.push(data);
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
  setTimeout() {}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("STARTTLS command pipelining", () => {
  it("drops cleartext commands buffered behind the socket swap", async () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);

    // Stand in for what `startTls` does at the end of a successful upgrade.
    const upgraded = new FakeSocket();
    const swap = () => handler.setSocket(upgraded as never);

    // One segment: a command that triggers the swap, then an injected command.
    // NOOP is used as the trigger so this test does not need TLS material —
    // the defect is in the drain loop, and any mid-loop swap exercises it.
    plain.emit("data", Buffer.from("a1 NOOP\r\na2 CAPABILITY\r\n"));
    swap();
    await flush();

    // The injected command must not be answered on either socket: not on the
    // cleartext one (the client has stopped reading it) and above all not on
    // the upgraded one, where it would look like the victim's own traffic.
    expect(upgraded.written.join("")).not.toContain("a2");
    expect(upgraded.written.join("")).not.toContain("CAPABILITY");
  });

  it("clears a half-finished SASL exchange across the swap", async () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);

    // An attacker's `AUTHENTICATE PLAIN` leaves the handler waiting for a
    // base64 continuation line. If that state survived the swap, the victim's
    // first encrypted command would be consumed as the response to it.
    handler.setPendingSaslTag("Z9");

    const upgraded = new FakeSocket();
    handler.setSocket(upgraded as never);
    upgraded.emit("data", Buffer.from("b1 CAPABILITY\r\n"));
    await flush();

    const answered = upgraded.written.join("");
    expect(answered).not.toContain("Z9");
    expect(answered).toContain("b1 OK CAPABILITY completed");
  });
});
