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

const makeSession = () => {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  };
  const upgrades: unknown[] = [];
  const handler = { isTls: false, setSocket: (s: unknown) => upgrades.push(s) };
  const session = new ImapSession(handler as never, socket as never);
  return { session, socket, writes, upgrades };
};

describe("IMAP STARTTLS without usable credentials", () => {
  let ssl: ReturnType<typeof createTlsEnvFixture>;

  beforeAll(() => {
    ssl = createTlsEnvFixture();
  });

  afterEach(() => ssl.restore());

  afterAll(() => ssl.cleanup());

  it("answers NO when no certificate is configured", async () => {
    ssl.use(undefined, undefined);
    const { session, socket, writes, upgrades } = makeSession();
    await session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    // The session keeps the cleartext socket — no half-upgraded state.
    expect(session.socket).toBe(socket as never);
    expect(upgrades).toHaveLength(0);
  });

  it("answers NO when the configured certificate files are absent", async () => {
    ssl.use(ssl.absentPath("absent-cert.pem"), ssl.absentPath("absent-key.pem"));
    const { session, writes, upgrades } = makeSession();
    await session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    expect(upgrades).toHaveLength(0);
  });

  it("answers NO when only the key file is absent", async () => {
    ssl.use(ssl.certPath, ssl.absentPath("absent-key.pem"));
    const { session, writes, upgrades } = makeSession();
    await session.startTls("A1");
    expect(writes.join("")).toBe("A1 NO STARTTLS is not available\r\n");
    expect(upgrades).toHaveLength(0);
  });

  it("does not refuse when both certificate files are present", async () => {
    // The staged files hold junk rather than a real key pair, so the upgrade
    // itself fails. The load-bearing assertion is that the guard let it
    // through and wrote no refusal — the upgrade path is unchanged by #763.
    ssl.use(ssl.certPath, ssl.keyPath);
    const { session, writes } = makeSession();
    await expect(session.startTls("A1")).rejects.toThrow();
    expect(writes.join("")).toBe("");
  });
});
