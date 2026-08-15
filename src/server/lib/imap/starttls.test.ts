/**
 * STARTTLS refusal path (inbox #763).
 *
 * CAPABILITY no longer offers STARTTLS without a readable certificate, so the
 * only way into `startTls` on a cert-less deployment is a client sending the
 * command unprompted. That must answer with a tagged NO instead of throwing an
 * ENOENT the handler can only report as `BAD Internal server error`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createTlsEnvFixture } from "test-helpers";
import { ImapSession } from "./session";

const makeSession = ({ isTls = false, authenticated = false } = {}) => {
  const writes: string[] = [];
  // One ordered log of everything the session does to the socket — the
  // detach-then-answer sequence is the part of the upgrade a fake socket can
  // still pin. "OK before the wrap" needs a real key pair, so E2E carries it.
  const calls: string[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write: (data: string) => {
      writes.push(data);
      calls.push(`write:${data.trimEnd()}`);
      return true;
    },
    removeAllListeners: (event: string) => calls.push(`removeAllListeners:${event}`),
  };
  const upgrades: unknown[] = [];
  const handler = { isTls, setSocket: (s: unknown) => upgrades.push(s) };
  const session = new ImapSession(handler as never, socket as never);
  // `authenticated` is private and only set by the LOGIN / AUTHENTICATE paths,
  // which need a live store. The state guard is what's under test, not how the
  // session got there.
  (session as unknown as { authenticated: boolean }).authenticated = authenticated;
  return { session, socket, writes, upgrades, handler, calls };
};

describe("IMAP STARTTLS without usable credentials", () => {
  let ssl: ReturnType<typeof createTlsEnvFixture>;

  beforeAll(() => {
    ssl = createTlsEnvFixture();
  });

  afterEach(() => ssl.restore());

  afterAll(() => ssl.cleanup());

  it("answers NO when no certificate is configured", () => {
    ssl.use(undefined, undefined);
    const { session, socket, writes, upgrades } = makeSession();
    session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    // The session keeps the cleartext socket — no half-upgraded state.
    expect(session.socket).toBe(socket as never);
    expect(upgrades).toHaveLength(0);
  });

  it("answers NO when the configured certificate files are absent", () => {
    ssl.use(ssl.absentPath("absent-cert.pem"), ssl.absentPath("absent-key.pem"));
    const { session, writes, upgrades } = makeSession();
    session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    expect(upgrades).toHaveLength(0);
  });

  it("answers NO when only the key file is absent", () => {
    ssl.use(ssl.certPath, ssl.absentPath("absent-key.pem"));
    const { session, writes, upgrades } = makeSession();
    session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    expect(upgrades).toHaveLength(0);
  });

  it("answers BAD on the implicit-TLS port, even with a usable certificate", () => {
    // Wrapping an already-encrypted socket waits for a `secure` event that a
    // client inside TLS never triggers, stalling the session's serial command
    // drain until the socket timeout. RFC 3501 §6.2.1: wrong state → BAD.
    ssl.use(ssl.certPath, ssl.keyPath);
    const { session, writes, upgrades } = makeSession({ isTls: true });
    session.startTls("A1");
    expect(writes.join("")).toBe("A1 BAD STARTTLS not permitted on a TLS connection\r\n");
    expect(upgrades).toHaveLength(0);
  });

  it("answers BAD after authentication", () => {
    ssl.use(ssl.certPath, ssl.keyPath);
    const { session, writes, upgrades } = makeSession({ authenticated: true });
    session.startTls("A1");
    expect(writes.join("")).toBe("A1 BAD STARTTLS not permitted after authentication\r\n");
    expect(upgrades).toHaveLength(0);
  });

  it("does not touch the socket's listeners when it refuses", () => {
    ssl.use(undefined, undefined);
    const { session, calls } = makeSession();
    session.startTls("A1");
    expect(calls).toEqual(["write:A1 NO STARTTLS is not available"]);
  });

  it("answers NO without upgrading when the staged files are not a key pair", () => {
    // The context is built before anything on the connection changes, so an
    // unparseable PEM is still answerable as a clean tagged NO.
    ssl.use(ssl.certPath, ssl.keyPath);
    const { session, writes, upgrades, handler } = makeSession();
    session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    expect(upgrades).toHaveLength(0);
    expect(handler.isTls).toBe(false);
  });
});
