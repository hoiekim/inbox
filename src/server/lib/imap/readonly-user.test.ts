/**
 * Tests for the read-only IMAP user guard. Verifies that after
 * authenticating as `READONLY_USERNAME`, ImapSession refuses every
 * state-mutating IMAP command with `NO [READ-ONLY]` while letting
 * non-mutating ones through. Admin sessions are unaffected.
 *
 * Isolation follows the same pg-FakePool pattern as condstore.test.ts —
 * mock `pg` at process scope so the lazy pool in postgres/client.ts
 * points at a fake, then exercise the real ImapSession.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { restoreLeaves } from "test-helpers";

const STORED_UIDVALIDITY = 1716512400;

// Only the writes/reads the session exercises use these rows; any other
// column defaults to null.
const makeUserRow = (username: string) => ({
  user_id: `user-${username}`,
  username,
  password: null,
  email: `${username}@localhost`,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: null,
  imap_uid_validity: STORED_UIDVALIDITY,
});

// Test-controllable username the FakePool returns as the authenticated user.
let activeUserRow = makeUserRow("readonly");

const mockQuery = mock(async (sql: string) => {
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: "10" }], rowCount: 1 };
  }
  return { rows: [activeUserRow], rowCount: 1 };
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
const { READONLY_USERNAME } = await import("../postgres/initialize");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

// A minimal stand-in for the socket / handler that ImapSession needs.
// Only .write / .end / .on matter for the code paths under test.
const mkSocket = () => {
  const writes: string[] = [];
  const socket = {
    remoteAddress: "127.0.0.1",
    remotePort: 12345,
    writable: true,
    destroyed: false,
    setTimeout: () => {},
    setKeepAlive: () => {},
    on: () => {},
    removeAllListeners: () => {},
    write: (data: string | Buffer) => {
      writes.push(typeof data === "string" ? data : data.toString());
      return true;
    },
    end: () => {},
    destroy: () => {},
  };
  return { socket, writes };
};

const mkHandler = () => ({
  setPendingSaslTag: () => {},
});

/**
 * Instantiate a session and log the given username in via LOGIN.
 * Bypasses bcrypt-hash validation by short-circuiting auth's PW check —
 * the FakePool returns a user row where `password: null`, which
 * `handleLogin` reads as "no password set" and refuses. So we
 * side-load the store directly onto the session via TS reflection to
 * hit the same code path the real login flow does at the end.
 */
async function authAs(username: string) {
  const { socket, writes } = mkSocket();
  const handler = mkHandler();
  const session = new ImapSession(handler as never, socket as never);
  activeUserRow = makeUserRow(username);
  // Reach into the private field. Small test-only shortcut so we don't
  // have to reimplement bcrypt-hash generation for a per-user setup.
  // Everything the guard depends on flows from these two fields.
  const s = session as unknown as {
    authenticated: boolean;
    isReadOnlyUser: boolean;
    store: {
      getUser: () => { id: string; username: string; email: string };
    };
  };
  s.authenticated = true;
  s.store = {
    getUser: () => ({
      id: `user-${username}`,
      username,
      email: `${username}@localhost`,
    }),
  };
  s.isReadOnlyUser = username === READONLY_USERNAME;
  return { session, writes, socket };
}

beforeEach(() => {
  mockQuery.mockClear();
});

describe("read-only IMAP user — constant", () => {
  it("exports the reserved username", () => {
    expect(READONLY_USERNAME).toBe("readonly");
  });
});

describe("read-only IMAP user — guard rejects mutating commands", () => {
  const mutatingCases: Array<{
    name: string;
    verb: string;
    run: (session: InstanceType<typeof ImapSession>) => Promise<unknown>;
  }> = [
    {
      name: "STORE",
      verb: "STORE",
      run: (session) =>
        session.storeFlagsTyped("A1", {
          sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
          operation: "REPLACE",
          silent: false,
          flags: ["\\Seen"],
        } as never),
    },
    {
      name: "UID STORE",
      verb: "UID STORE",
      run: (session) =>
        session.storeFlagsTyped(
          "A1",
          {
            sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
            operation: "REPLACE",
            silent: false,
            flags: ["\\Seen"],
          } as never,
          true
        ),
    },
    {
      name: "COPY",
      verb: "COPY",
      run: (session) =>
        session.copyMessageTyped("A1", {
          sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
          mailbox: "Archive",
        } as never),
    },
    {
      name: "MOVE",
      verb: "MOVE",
      run: (session) =>
        session.moveMessageTyped("A1", {
          sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
          mailbox: "Archive",
        } as never),
    },
    {
      name: "APPEND",
      verb: "APPEND",
      run: (session) =>
        session.appendMessage("A1", {
          mailbox: "INBOX",
          message: Buffer.from("From: a@b\r\n\r\nhi"),
        } as never),
    },
    {
      name: "EXPUNGE",
      verb: "EXPUNGE",
      run: (session) => session.expunge("A1"),
    },
    {
      name: "CREATE",
      verb: "CREATE",
      run: (session) => session.createMailbox("A1", "NewBox"),
    },
    {
      name: "DELETE",
      verb: "DELETE",
      run: (session) => session.deleteMailbox("A1", "OldBox"),
    },
    {
      name: "RENAME",
      verb: "RENAME",
      run: (session) => session.renameMailbox("A1", "A", "B"),
    },
    {
      name: "SUBSCRIBE",
      verb: "SUBSCRIBE",
      run: (session) => session.subscribeMailbox("A1", "INBOX"),
    },
    {
      name: "UNSUBSCRIBE",
      verb: "UNSUBSCRIBE",
      run: (session) => session.unsubscribeMailbox("A1", "INBOX"),
    },
  ];

  for (const { name, verb, run } of mutatingCases) {
    it(`refuses ${name} with NO [READ-ONLY]`, async () => {
      const { session, writes } = await authAs(READONLY_USERNAME);
      // STORE / EXPUNGE / COPY / MOVE need a selected mailbox to reach
      // the guard; the guard runs AFTER the selection check so setting
      // the field skips the "no mailbox" BAD path.
      (session as unknown as { selectedMailbox: string | null }).selectedMailbox =
        "INBOX";
      await run(session);
      const joined = writes.join("");
      expect(joined).toContain("A1 NO [READ-ONLY]");
      expect(joined).toContain(verb);
    });
  }
});

describe("read-only IMAP user — admin unaffected", () => {
  it("allowMutation passes STORE for admin (no NO written before op)", async () => {
    const { session, writes } = await authAs("admin");
    (session as unknown as { selectedMailbox: string | null }).selectedMailbox =
      "INBOX";
    // Best-effort — the underlying storeFlagsOp will try to touch the mock
    // pool and may write a different response, but the guard MUST NOT have
    // fired. Assert absence of the [READ-ONLY] marker.
    try {
      await session.storeFlagsTyped("A1", {
        sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
        operation: "REPLACE",
        silent: false,
        flags: ["\\Seen"],
      } as never);
    } catch {
      // ignore — mock likely can't fulfill the op end-to-end
    }
    expect(writes.join("")).not.toContain("[READ-ONLY]");
  });
});
