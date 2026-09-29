import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import { restoreLeaves } from "test-helpers";
import bcrypt from "bcryptjs";
import type { ImapSession } from "./session";
import {
  registerAuthenticatedSession,
  unregisterSession,
  evictImapSessions,
  getAuthenticatedSessionCount,
} from "./session-registry";

// The wiring suite at the bottom drives the real LOGIN path, which reads the
// users table. Same pg-FakePool pattern as readonly-user.test.ts: mock `pg` at
// process scope so the lazy pool in postgres/client.ts points at a fake, then
// exercise the real ImapSession.
const PASSWORD = "correct-horse-battery";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const makeUserRow = (username: string) => ({
  user_id: `user-${username}`,
  username,
  password: PASSWORD_HASH,
  email: `${username}@localhost`,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: null,
  imap_uid_validity: null,
});

const mockQuery = mock(async (_sql: string, values?: unknown[]) => {
  const username = values?.find((v) => typeof v === "string") as string;
  return { rows: [makeUserRow(username ?? "alice")], rowCount: 1 };
});

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const { ImapSession } = await import("./session");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

const tracked: ImapSession[] = [];

const makeSession = (
  authenticatedAs: string | null,
  options: { closeThrows?: boolean } = {}
) => {
  const calls: string[] = [];
  const write = mock((data: string) => {
    calls.push(`write:${data}`);
    return true;
  });
  const close = mock(() => {
    calls.push("close");
    if (options.closeThrows) throw new Error("socket already gone");
  });
  const session = {
    write,
    close,
    getAuthenticatedAs: () => authenticatedAs,
    getSessionId: () => `s-${authenticatedAs}`,
  } as unknown as ImapSession;
  return { session, write, close, calls };
};

const register = (
  authenticatedAs: string | null,
  options: { closeThrows?: boolean } = {}
) => {
  const fake = makeSession(authenticatedAs, options);
  registerAuthenticatedSession(fake.session);
  tracked.push(fake.session);
  return fake;
};

beforeEach(() => {
  tracked.length = 0;
});

afterEach(() => {
  // The registry is module state shared by every suite in this process.
  tracked.forEach(unregisterSession);
});

describe("evictImapSessions", () => {
  it("tears down every connection that authenticated as the username", () => {
    const first = register("alice");
    const second = register("alice");

    expect(evictImapSessions("alice")).toBe(2);

    [first, second].forEach(({ calls }) => {
      expect(calls).toEqual([
        "write:* BYE Credential changed, please re-authenticate\r\n",
        "close",
      ]);
    });
  });

  it("leaves every other credential's connection untouched", () => {
    const alice = register("alice");
    const bob = register("bob");
    const unauthenticated = register(null);

    expect(evictImapSessions("alice")).toBe(1);

    expect(alice.close).toHaveBeenCalledTimes(1);
    expect(bob.close).not.toHaveBeenCalled();
    expect(bob.write).not.toHaveBeenCalled();
    expect(unauthenticated.close).not.toHaveBeenCalled();
  });

  it("spares a read-only session when the account it reads rotates", () => {
    // The read-only credential is its own user row with its own password, so a
    // rotation on the account it reads does not revoke it. Keying the sweep on
    // the effective user instead of the presented credential would cut it off.
    const readOnly = register("admin-ro");
    const admin = register("admin");

    expect(evictImapSessions("admin")).toBe(1);

    expect(admin.close).toHaveBeenCalledTimes(1);
    expect(readOnly.close).not.toHaveBeenCalled();
  });

  it("does not re-tear a connection whose socket has already closed", () => {
    const closed = register("alice");
    unregisterSession(closed.session);

    expect(evictImapSessions("alice")).toBe(0);
    expect(closed.close).not.toHaveBeenCalled();
  });

  it("keeps sweeping after a connection refuses teardown", () => {
    const refuses = register("alice", { closeThrows: true });
    const healthy = register("alice");

    expect(evictImapSessions("alice")).toBe(1);

    expect(refuses.close).toHaveBeenCalledTimes(1);
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });

  it("drops an evicted connection from the registry", () => {
    const before = getAuthenticatedSessionCount();
    const alice = register("alice");
    expect(getAuthenticatedSessionCount()).toBe(before + 1);

    evictImapSessions("alice");

    expect(getAuthenticatedSessionCount()).toBe(before);
    expect(alice.close).toHaveBeenCalledTimes(1);
  });

  it("reports nothing evicted when no connection matches", () => {
    const bob = register("bob");

    expect(evictImapSessions("alice")).toBe(0);
    expect(bob.close).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Wiring: the sweep above is only reachable if ImapSession actually registers
// on a successful auth and unregisters when its socket closes. These drive the
// real LOGIN path and the real cleanup, so a dropped call site fails here even
// though every unit case above still passes.
// ───────────────────────────────────────────────────────────────────────────

const mkSocket = () => {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  const socket = {
    remoteAddress: "127.0.0.1",
    remotePort: 12345,
    writable: true,
    destroyed: false,
    setTimeout: () => {},
    setKeepAlive: () => {},
    on: () => {},
    // `closeSocket` arms a destroy fallback and disarms it on the socket's own
    // close event, so the stub has to deliver that event for the teardown to
    // complete the way a real socket's does.
    once: (event: string, listener: () => void) => {
      if (event === "close") closeHandlers.push(listener);
    },
    removeAllListeners: () => {},
    removeListener: () => {},
    write: (data: string | Buffer) => {
      writes.push(typeof data === "string" ? data : data.toString());
      return true;
    },
    end: () => {
      socket.destroyed = true;
      socket.writable = false;
      closeHandlers.splice(0).forEach((listener) => listener());
    },
    destroy: () => {
      socket.destroyed = true;
    },
  };
  return { socket, writes };
};

const loginAs = async (username: string, password = PASSWORD) => {
  const { socket, writes } = mkSocket();
  const handler = { setPendingSaslTag: () => {}, isTls: false };
  const session = new ImapSession(handler as never, socket as never);
  await session.login("A1", [username, password]);
  return { session: session as unknown as ImapSession, writes };
};

const authenticateAs = async (username: string, password = PASSWORD) => {
  const { socket, writes } = mkSocket();
  const handler = { setPendingSaslTag: () => {}, isTls: false };
  const session = new ImapSession(handler as never, socket as never);
  const payload = Buffer.from(
    ["", username, password].join(String.fromCharCode(0))
  ).toString("base64");
  await session.authenticate("A1", "PLAIN", payload);
  return { session: session as unknown as ImapSession, writes };
};

describe("ImapSession registration wiring", () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it("registers a session that completed LOGIN, and the sweep reaches it", async () => {
    const before = getAuthenticatedSessionCount();
    const { session, writes } = await loginAs("alice");

    expect(writes.join("")).toContain("A1 OK");
    expect(getAuthenticatedSessionCount()).toBe(before + 1);

    expect(evictImapSessions("alice")).toBe(1);

    expect(writes.join("")).toContain("* BYE Credential changed");
    expect(getAuthenticatedSessionCount()).toBe(before);
    unregisterSession(session);
  });

  it("registers a session that completed AUTHENTICATE PLAIN", async () => {
    // SASL PLAIN is what mail clients negotiate in preference to the legacy
    // LOGIN command, so this is the call site real long-lived connections take.
    const before = getAuthenticatedSessionCount();
    const { session, writes } = await authenticateAs("alice");

    expect(writes.join("")).toContain("A1 OK");
    expect(getAuthenticatedSessionCount()).toBe(before + 1);

    expect(evictImapSessions("alice")).toBe(1);

    expect(writes.join("")).toContain("* BYE Credential changed");
    expect(getAuthenticatedSessionCount()).toBe(before);
    unregisterSession(session);
  });

  it("does not register a session whose LOGIN failed", async () => {
    const before = getAuthenticatedSessionCount();
    const { session, writes } = await loginAs("alice", "wrong-password");

    expect(writes.join("")).toContain("AUTHENTICATIONFAILED");
    expect(getAuthenticatedSessionCount()).toBe(before);
    unregisterSession(session);
  });

  it("unregisters on cleanup, which runs on every socket close", async () => {
    const before = getAuthenticatedSessionCount();
    const { session } = await loginAs("alice");
    expect(getAuthenticatedSessionCount()).toBe(before + 1);

    session.cleanup();

    expect(getAuthenticatedSessionCount()).toBe(before);
    expect(evictImapSessions("alice")).toBe(0);
  });
});
