
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
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

/**
 * Source-order assertions for the two steps of the upgrade a fake socket cannot
 * observe. Both failure modes are hangs rather than errors — the client waits
 * for a line that is never sent in the clear, or sends a ClientHello that the
 * cleartext reader eats — so nothing in the behavioural suite goes red when the
 * order is wrong. Pinning the source is the only check that does not require a
 * live key pair, and no PEM private key belongs in this repo's tests.
 */
describe("IMAP STARTTLS upgrade ordering (source scan)", () => {
  const source = readFileSync(
    join(import.meta.dir, "session.ts"),
    "utf8"
  );
  const startTls = source.slice(source.indexOf("startTls = "));

  it("writes the tagged OK before wrapping the socket (RFC 3501 §6.2.1)", () => {
    const ok = startTls.indexOf("OK Begin TLS negotiation now");
    const wrap = startTls.indexOf("new TLSSocket(");
    expect(ok).toBeGreaterThan(-1);
    expect(wrap).toBeGreaterThan(-1);
    expect(ok).toBeLessThan(wrap);
  });

  it("detaches the cleartext data listener before wrapping the socket", () => {
    const detach = startTls.indexOf('removeAllListeners("data")');
    const wrap = startTls.indexOf("new TLSSocket(");
    expect(detach).toBeGreaterThan(-1);
    expect(detach).toBeLessThan(wrap);
  });
});
