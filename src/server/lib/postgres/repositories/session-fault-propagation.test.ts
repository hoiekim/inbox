/**
 * A DB fault on the session store's read, write or purge path must reach the
 * caller instead of being reported as a successful, empty, or idempotent
 * outcome. `express-session`'s `Store` protocol treats `callback(null)` as an
 * affirmative claim that the write landed and `callback(null, null)` as an
 * affirmative claim that no such session exists, so a swallowed fault here
 * answers a successful login whose row was never written, or logs a live user
 * out at random.
 *
 * The stub is installed through the pool Proxy's set trap rather than
 * `mock.module("pg", ...)` — same seam as `session-destroy-propagation.test.ts`.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { SignedUser } from "common";
import { pool, resetPool } from "../client";
import {
  PostgresSessionStore,
  purgeSessions,
  deleteSessionsAuthenticatedAs,
} from "./sessions";

type Mode = "ok" | "empty" | "throw";

let writeMode: Mode = "ok";
let readMode: Mode = "ok";
let purgeMode: Mode = "ok";
let revokeMode: Mode = "ok";

const SESSION_ID = "fault-propagation-session-id";
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;

const USER = new SignedUser({
  id: "11111111-2222-3333-4444-555555555555",
  username: "alice",
  email: "alice@example.com",
});

const liveSessionRow = () => ({
  session_id: SESSION_ID,
  session_user_id: USER.id,
  session_username: USER.username,
  session_email: USER.email,
  session_is_read_only: null,
  session_authenticated_as: null,
  cookie_original_max_age: WEEK_MS,
  cookie_max_age: WEEK_MS,
  cookie_signed: null,
  cookie_expires: new Date(Date.now() + WEEK_MS).toISOString(),
  cookie_http_only: true,
  cookie_path: "/",
  cookie_domain: null,
  cookie_secure: "false",
  cookie_same_site: '"strict"',
  updated: new Date().toISOString(),
});

const mockQuery = mock(async (sql: string) => {
  if (sql.startsWith("INSERT INTO sessions")) {
    if (writeMode === "throw") throw new Error("could not serialize session write");
    const rows = writeMode === "empty" ? [] : [liveSessionRow()];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT") && sql.includes("FROM sessions")) {
    if (readMode === "throw") throw new Error("connection terminated unexpectedly");
    const rows = readMode === "empty" ? [] : [liveSessionRow()];
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("DELETE FROM sessions") && sql.includes("cookie_expires")) {
    if (purgeMode === "throw") throw new Error("permission denied for table sessions");
    return { rows: [{ session_id: SESSION_ID }], rowCount: 1 };
  }
  if (sql.startsWith("DELETE FROM sessions") && sql.includes("session_authenticated_as")) {
    if (revokeMode === "throw") throw new Error("deadlock detected");
    return { rows: [{ session_id: SESSION_ID }], rowCount: 1 };
  }
  return { rows: [] as unknown[], rowCount: 0 as number | null };
});

const installQueryStub = () => {
  (pool as unknown as { query: typeof mockQuery }).query = mockQuery;
};

resetPool();
installQueryStub();
const store = new PostgresSessionStore();

afterAll(() => {
  resetPool();
});

beforeEach(() => {
  writeMode = "ok";
  readMode = "ok";
  purgeMode = "ok";
  revokeMode = "ok";
  installQueryStub();
});

const runtimeSession = () =>
  ({
    user: USER,
    cookie: {
      originalMaxAge: WEEK_MS,
      maxAge: WEEK_MS,
      signed: false,
      _expires: new Date(Date.now() + WEEK_MS),
      httpOnly: true,
      path: "/",
      domain: undefined,
      secure: false,
      sameSite: "strict" as const,
    },
  }) as never;

/** Resolves with whatever `set` hands its callback — an error or null. */
const setResult = (session_id: string) =>
  new Promise<unknown>((resolve) => {
    store.set(session_id, runtimeSession(), (err) => resolve(err ?? null));
  });

/** Resolves with the full callback arguments so an error is distinguishable
 * from the affirmative "no such session" answer. */
const getResult = (session_id: string) =>
  new Promise<{ err: unknown; session: unknown }>((resolve) => {
    store.get(session_id, (err, session) => resolve({ err, session: session ?? null }));
  });

describe("PostgresSessionStore.set", () => {
  it("calls back with the error when the session write raises", async () => {
    writeMode = "throw";

    const err = await setResult(SESSION_ID);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("could not serialize session write");
  });

  it("calls back null when the write lands", async () => {
    const err = await setResult(SESSION_ID);

    expect(err).toBeNull();
  });
});

describe("PostgresSessionStore.get", () => {
  it("calls back with the error when the session read raises", async () => {
    readMode = "throw";

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("connection terminated unexpectedly");
    // A read fault must not reach the caller as the absent-session answer:
    // express-session mints a fresh id on that branch, orphaning the live row.
    expect(session).toBeFalsy();
  });

  it("calls back with no session and no error when the row is genuinely absent", async () => {
    readMode = "empty";

    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect(session).toBeNull();
  });

  it("calls back with the stored session when the row is present", async () => {
    const { err, session } = await getResult(SESSION_ID);

    expect(err).toBeNull();
    expect((session as { user: SignedUser }).user.id).toBe(USER.id);
  });
});

describe("purgeSessions", () => {
  it("rejects when the sweep raises", async () => {
    purgeMode = "throw";

    await expect(purgeSessions()).rejects.toThrow("permission denied for table sessions");
  });

  it("resolves the deleted count when the sweep lands", async () => {
    await expect(purgeSessions()).resolves.toBe(1);
  });
});

describe("deleteSessionsAuthenticatedAs", () => {
  it("rejects when the revocation delete raises", async () => {
    revokeMode = "throw";

    await expect(deleteSessionsAuthenticatedAs("admin-ro")).rejects.toThrow("deadlock detected");
  });

  it("resolves the deleted count when the revocation lands", async () => {
    await expect(deleteSessionsAuthenticatedAs("admin-ro")).resolves.toBe(1);
  });
});
