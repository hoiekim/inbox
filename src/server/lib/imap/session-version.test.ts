/**
 * IMAP credential-revocation fence (issue #1016): `verifyCredentialVersion`
 * de-authenticates a connection whose credential rotated after it
 * authenticated, and lets a current one through untouched.
 *
 * These tests drive the real `ImapSession` with the `server` barrel mocked
 * at the `getUser` seam — the fence's only external read — following the
 * `readonly-user.test.ts` pattern of priming private fields directly rather
 * than driving bcrypt/LOGIN end-to-end.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { ImapSession } from "./session";

const realServer = (globalThis as Record<string, unknown>)
  .__REAL_SERVER as Record<string, unknown>;

const mockGetUser = mock(
  (_input: unknown): Promise<unknown> => Promise.resolve(null)
);
const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

/**
 * Spread the real barrel rather than listing exports: `mock.module`
 * replaces the export graph-wide, so a hand-picked object deletes every
 * other `server` export for the rest of this file.
 */
mock.module("server", () => ({
  ...realServer,
  getUser: mockGetUser,
  logger: mockLogger,
}));

afterAll(() => {
  mock.module("server", () => realServer);
  restoreLeaves();
});

beforeEach(() => {
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(() => Promise.resolve(null));
  mockLogger.info.mockClear();
});

const mkSocket = () => {
  const writes: string[] = [];
  const socket = {
    write: (data: string) => {
      writes.push(data);
      return true;
    },
    destroyed: false,
    writable: true,
  };
  return { socket, writes };
};

const mkHandler = () => ({ setPendingSaslTag: () => {} });

type PrimedSession = ImapSession & {
  authenticated: boolean;
  authenticatedAs: string | null;
  credentialPasswordVersion: number | null;
};

const primeAuthenticated = (
  stampedVersion: number,
  authenticatedAs = "alice"
): { session: PrimedSession; writes: string[] } => {
  const { socket, writes } = mkSocket();
  const handler = mkHandler();
  const session = new ImapSession(handler as never, socket as never);
  const s = session as unknown as PrimedSession;
  s.authenticated = true;
  s.authenticatedAs = authenticatedAs;
  s.credentialPasswordVersion = stampedVersion;
  return { session: s, writes };
};

describe("ImapSession.verifyCredentialVersion", () => {
  it("de-authenticates and answers NO [AUTHENTICATIONFAILED] when the credential rotated after auth", async () => {
    // The row is on generation 2; this connection was stamped with 1.
    mockGetUser.mockImplementation(() =>
      Promise.resolve({ passwordVersion: 2 })
    );
    const { session, writes } = primeAuthenticated(1);

    const ok = await session.verifyCredentialVersion("A1");

    expect(ok).toBe(false);
    expect(writes).toEqual([
      "A1 NO [AUTHENTICATIONFAILED] Credential changed, please re-authenticate\r\n",
    ]);
    // The grant is gone: a follow-up command must see an unauthenticated
    // session, not merely a refused one.
    expect(session.isAuthenticated()).toBe(false);
  });

  it("lets the command through when the stamped version is current", async () => {
    mockGetUser.mockImplementation(() =>
      Promise.resolve({ passwordVersion: 2 })
    );
    const { session, writes } = primeAuthenticated(2);

    const ok = await session.verifyCredentialVersion("A2");

    expect(ok).toBe(true);
    expect(writes).toEqual([]);
    expect(session.isAuthenticated()).toBe(true);
  });

  it("treats a missing version as generation 1 on both sides", async () => {
    // Rows that predate the fence's migration read back null.
    mockGetUser.mockImplementation(() => Promise.resolve({}));
    const { session } = primeAuthenticated(1);

    expect(await session.verifyCredentialVersion("A3")).toBe(true);
    expect(session.isAuthenticated()).toBe(true);
  });

  it("does not touch the database for an unauthenticated session", async () => {
    const { socket, writes } = mkSocket();
    const session = new ImapSession(mkHandler() as never, socket as never);

    expect(await session.verifyCredentialVersion("A4")).toBe(true);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("keys the comparison on the credential presented, not a remapped user", async () => {
    // A read-only session authenticates as its own credential row; the
    // comparison must follow `authenticatedAs`, matching the eviction
    // registry's keying.
    mockGetUser.mockImplementation((input: unknown) => {
      const { username } = input as { username: string };
      expect(username).toBe("admin-ro");
      return Promise.resolve({ passwordVersion: 2 });
    });
    const { session } = primeAuthenticated(1, "admin-ro");

    expect(await session.verifyCredentialVersion("A5")).toBe(false);
    expect(session.isAuthenticated()).toBe(false);
  });
});
