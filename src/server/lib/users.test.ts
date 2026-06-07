import {
  describe,
  expect,
  it,
  afterEach,
  beforeEach,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";
import { restoreLeaves } from "test-helpers";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User } from "common";

// Native mock.module pattern (mirrors budget's repositories/users.test.ts):
// mock `pg` so the lazy pool in `postgres/client.ts` instantiates this
// FakePool, then run the REAL `users.ts` functions against it. `mockQuery`
// is the single seam every `usersTable` / `pgSearchUser` call funnels through
// (`pool.query`). `afterAll(restoreLeaves)` re-mocks pg back to the preload's
// real snapshot and `resetPool()` drops the cached FakePool so the next test
// file in the same `bun test` process starts from the real Pool. No DI.
const mockQuery = mock(
  async (_sql: string, _values?: unknown[]) =>
    ({ rows: [] as unknown[], rowCount: 0 as number | null })
);

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  // client.ts registers `pool.on("error", ...)` at import time — the lazy
  // Proxy instantiates this FakePool on that first access, so `on` must exist.
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

// Import the subjects AND resetPool only after the pg mock is registered, so
// `client.ts`'s `import { Pool } from "pg"` resolves to FakePool.
const {
  getSignedUser,
  isValidEmail,
  createAuthenticationMail,
  getUser,
  getUsers,
  getActiveUsers,
  createToken,
  setUserInfo,
  startTimer,
  encryptPassword,
  expiryTimer,
} = await import("./users");
const { resetPool } = await import("./postgres/client");

beforeAll(() => {
  // `mock.module` is process-global: a sibling test file that ran earlier in
  // the same `bun test` process may have restored `pg` to the real module in
  // its `afterAll(restoreLeaves)` and/or instantiated the lazy pool against the
  // real Pool. Re-assert our pg mock and drop any cached pool right before this
  // file's tests, so every query below hits FakePool — not real Postgres (which
  // is ECONNREFUSED on CI). This is the contract the lazy pool documents.
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

beforeEach(() => {
  // Reset call history AND restore the default (no-rows) resolution, so a
  // call beyond the queued `mockResolvedValueOnce` values still resolves to an
  // empty result instead of `undefined`. resetPool() guarantees the next query
  // rebuilds against FakePool regardless of cross-file mock leakage.
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  resetPool();
});

// A full users-table row. UserModel's constructor validates EVERY column via
// its typeChecker, so a partial row would throw ModelValidationError before
// `toUser()` runs. Override only what a given test cares about.
const makeUserRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u-1",
  username: "alice",
  password: "hashed",
  email: "alice@example.com",
  expiry: null,
  token: null,
  updated: null,
  is_deleted: false,
  imap_uid_validity: null,
  ...overrides,
});

const rows = (...r: Record<string, unknown>[]) => ({
  rows: r,
  rowCount: r.length,
});

describe("Token generation security", () => {
  it("uses cryptographically secure random bytes", () => {
    const token = crypto.randomBytes(32).toString("hex");
    expect(token.length).toBe(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = crypto.randomBytes(32).toString("hex");
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
    expect(tokens.size).toBe(100);
  });

  it("has sufficient entropy (256 bits)", () => {
    const bytes = crypto.randomBytes(32);
    expect(bytes.length).toBe(32);
  });
});

describe("getSignedUser", () => {
  it("returns undefined when user is undefined", () => {
    expect(getSignedUser(undefined)).toBeUndefined();
  });

  it("returns undefined when id is missing", () => {
    const user = new User({
      username: "alice",
      email: "alice@example.com",
      password: "hash",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns undefined when username is missing", () => {
    const user = new User({
      id: "u1",
      email: "alice@example.com",
      password: "hash",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns undefined when email is missing", () => {
    const user = new User({
      id: "u1",
      username: "alice",
      password: "hash",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns undefined when password is missing", () => {
    const user = new User({
      id: "u1",
      username: "alice",
      email: "alice@example.com",
    });
    expect(getSignedUser(user)).toBeUndefined();
  });

  it("returns the user when all required fields are present", () => {
    const user = new User({
      id: "u1",
      username: "alice",
      email: "alice@example.com",
      password: "hash",
    });
    expect(getSignedUser(user)).toBe(user);
  });
});

describe("isValidEmail", () => {
  it("accepts a simple address", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("accepts plus addressing", () => {
    expect(isValidEmail("user+tag@example.com")).toBe(true);
  });

  it("accepts dots, underscores, hyphens, and percent in local part", () => {
    expect(isValidEmail("a.b_c-d%e@example.com")).toBe(true);
  });

  it("accepts subdomain in domain part", () => {
    expect(isValidEmail("user@mail.example.co.uk")).toBe(true);
  });

  it("accepts hyphenated domain labels", () => {
    expect(isValidEmail("user@my-host.example.com")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isValidEmail("USER@EXAMPLE.COM")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects address without @", () => {
    expect(isValidEmail("userexample.com")).toBe(false);
  });

  it("rejects address with multiple @", () => {
    expect(isValidEmail("user@@example.com")).toBe(false);
    expect(isValidEmail("a@b@example.com")).toBe(false);
  });

  it("rejects domain without a dot", () => {
    expect(isValidEmail("user@localhost")).toBe(false);
  });

  it("rejects empty local part", () => {
    expect(isValidEmail("@example.com")).toBe(false);
  });

  it("rejects empty domain part", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects local part with disallowed characters", () => {
    expect(isValidEmail("user name@example.com")).toBe(false);
    expect(isValidEmail("user!@example.com")).toBe(false);
  });

  it("rejects domain with disallowed characters", () => {
    expect(isValidEmail("user@exa_mple.com")).toBe(false);
    expect(isValidEmail("user@exa mple.com")).toBe(false);
  });
});

describe("createAuthenticationMail", () => {
  const originalHostname = process.env.APP_HOSTNAME;

  afterEach(() => {
    if (originalHostname !== undefined) {
      process.env.APP_HOSTNAME = originalHostname;
    } else {
      delete process.env.APP_HOSTNAME;
    }
  });

  it("returns expected envelope fields", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123");
    expect(mail.sender).toBe("admin");
    expect(mail.senderFullName).toBe("Administrator");
    expect(mail.to).toBe("alice@example.com");
    expect(mail.subject).toBe("Please set your password for Inbox");
  });

  it("embeds email and token in confirmation link", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123");
    expect(mail.html).toContain("/set-info/alice@example.com?t=tok123");
  });

  it("appends username when provided", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123", "alice");
    expect(mail.html).toContain("/set-info/alice@example.com?t=tok123&u=alice");
  });

  it("omits username param when not provided", () => {
    const mail = createAuthenticationMail("alice@example.com", "tok123");
    expect(mail.html).not.toContain("&u=");
  });
});

describe("getUser", () => {
  it("issues no query and returns undefined when no filter field is set (pgSearchUser short-circuits empty filters)", async () => {
    const result = await getUser({});
    expect(result).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns undefined when no row matches", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    const result = await getUser({ email: "missing@example.com" });
    expect(result).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("maps a found pg row into a common User (user_id → id) with password preserved", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "alice",
          email: "alice@example.com",
          password: "hashed",
        })
      )
    );
    const result = await getUser({ id: "u-1" });
    expect(result).toBeInstanceOf(User);
    expect(result?.id).toBe("u-1");
    expect(result?.username).toBe("alice");
    expect(result?.email).toBe("alice@example.com");
    expect(result?.password).toBe("hashed");
  });

  it("forwards id/username/email into the SELECT parameter values", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    await getUser({
      id: "u-1",
      username: "alice",
      email: "alice@example.com",
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SELECT");
    expect(values).toEqual(
      expect.arrayContaining(["u-1", "alice", "alice@example.com"])
    );
  });

  it("coerces a null pg email to undefined on the returned User", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ user_id: "u-1", email: null, password: "hashed" }))
    );
    const result = await getUser({ id: "u-1" });
    expect(result?.email).toBeUndefined();
  });
});

describe("getUsers", () => {
  it("returns empty list when input is empty (no DB calls)", async () => {
    const result = await getUsers([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("collects only the users that resolve (drops not-found inputs)", async () => {
    mockQuery
      .mockResolvedValueOnce(rows(makeUserRow({ user_id: "u-1" })))
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(
        rows(makeUserRow({ user_id: "u-3", username: "carol" }))
      );

    const result = await getUsers([
      { id: "u-1" },
      { id: "u-missing" },
      { id: "u-3" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("u-1");
    expect(result[1].id).toBe("u-3");
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

describe("getActiveUsers", () => {
  it("returns SignedUsers for inputs that have all required fields", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "alice",
          email: "alice@example.com",
          password: "hashed",
        })
      )
    );
    const result = await getActiveUsers([{ id: "u-1" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("u-1");
    expect(result[0].email).toBe("alice@example.com");
    expect(result[0].username).toBe("alice");
  });

  it("drops users missing required signed fields (no email)", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(makeUserRow({ user_id: "u-1", email: null, password: "hashed" }))
    );
    const result = await getActiveUsers([{ id: "u-1" }]);
    expect(result).toEqual([]);
  });

  it("drops users that are not found at all", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    const result = await getActiveUsers([{ id: "u-missing" }]);
    expect(result).toEqual([]);
  });
});

describe("createToken", () => {
  it("issues UPDATE for an existing email, returns the existing user_id and username", async () => {
    mockQuery
      // getUser({ email }) → SELECT returns the existing user
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-existing",
            username: "alice",
            email: "alice@example.com",
            password: "hashed",
          })
        )
      )
      // usersTable.update(...) → UPDATE ... RETURNING user_id
      .mockResolvedValueOnce(rows({ user_id: "u-existing" }));

    const result = await createToken("alice@example.com");
    expect(result.id).toBe("u-existing");
    expect(result.username).toBe("alice");
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [sql, values] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("UPDATE");
    expect(values).toEqual(expect.arrayContaining([result.token, "u-existing"]));
  });

  it("issues INSERT for a new email, returns a UUID id and undefined username", async () => {
    // Both calls return no rows: SELECT finds nothing (→ new), INSERT's
    // return value is unused by createToken's new-account branch.
    const result = await createToken("new@example.com");
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(result.username).toBeUndefined();
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [sql, values] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("INSERT");
    expect(values).toEqual(
      expect.arrayContaining([result.id, "new@example.com", result.token])
    );
    // username defaults to `user_<first 8 of uuid>`
    expect(values.some((v) => typeof v === "string" && /^user_/.test(v))).toBe(
      true
    );
  });

  it("generated tokens are unique across calls", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await createToken(`u${i}@example.com`);
      tokens.add(result.token);
    }
    expect(tokens.size).toBe(5);
  });
});

describe("encryptPassword", () => {
  it("produces a bcrypt hash that verifies against the original password", async () => {
    const hash = await encryptPassword("hunter2");
    expect(typeof hash).toBe("string");
    expect(hash).not.toBe("hunter2");
    // bcrypt prefix: $2a$ / $2b$ / $2y$
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare("hunter2", hash)).toBe(true);
    expect(await bcrypt.compare("wrong", hash)).toBe(false);
  });
});

describe("setUserInfo", () => {
  it("throws when email is missing", async () => {
    await expect(
      setUserInfo({ username: "alice", password: "p" })
    ).rejects.toThrow(/input is invalid/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when username is missing", async () => {
    await expect(
      setUserInfo({ email: "a@b.c", password: "p" })
    ).rejects.toThrow(/input is invalid/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when password is missing", async () => {
    await expect(
      setUserInfo({ email: "a@b.c", username: "alice" })
    ).rejects.toThrow(/input is invalid/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when user does not exist", async () => {
    mockQuery.mockResolvedValueOnce(rows());
    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "p",
        token: "tok",
      })
    ).rejects.toThrow(/user doesn't exist/);
  });

  it("throws (and issues no UPDATE) when token does not match the stored token", async () => {
    mockQuery.mockResolvedValueOnce(
      rows(
        makeUserRow({
          user_id: "u-1",
          username: "alice",
          email: "a@b.c",
          password: "hash",
          token: "stored-token",
        })
      )
    );
    await expect(
      setUserInfo({
        email: "a@b.c",
        username: "alice",
        password: "p",
        token: "wrong-token",
      })
    ).rejects.toThrow(/token doesn't match/);
    // Only the SELECT ran — no UPDATE.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("updates the row on matching token for a user whose username is already set", async () => {
    // existingUser.username is set → setUserInfo skips the new-account path
    // (expiry / collision checks) and goes straight to UPDATE with the new
    // password, clearing token+expiry. The existing username wins over input.
    mockQuery
      .mockResolvedValueOnce(
        rows(
          makeUserRow({
            user_id: "u-1",
            username: "alice",
            email: "a@b.c",
            password: "hash",
            token: "tok",
          })
        )
      )
      .mockResolvedValueOnce(rows({ user_id: "u-1" }));

    await setUserInfo({
      email: "a@b.c",
      username: "ignored-because-already-set",
      password: "newpw",
      token: "tok",
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql, values] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("UPDATE");
    // existing username wins; token + expiry cleared to null; password hashed.
    expect(values).toContain("alice");
    expect(values).toContain(null);
    expect(values).toContain("u-1");
    const hashed = values.find(
      (v) => typeof v === "string" && /^\$2[aby]\$/.test(v)
    );
    expect(hashed).toBeDefined();
    expect(values).not.toContain("newpw");
  });
});

describe("startTimer", () => {
  beforeEach(() => {
    for (const k of Object.keys(expiryTimer)) {
      clearTimeout(expiryTimer[k]);
      delete expiryTimer[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(expiryTimer)) {
      clearTimeout(expiryTimer[k]);
      delete expiryTimer[k];
    }
  });

  it("registers a timer keyed by userId", () => {
    startTimer("u-1");
    expect(expiryTimer["u-1"]).toBeDefined();
  });

  it("replaces an existing timer for the same userId (no duplicate fires)", () => {
    startTimer("u-1");
    const firstTimer = expiryTimer["u-1"];
    startTimer("u-1");
    const secondTimer = expiryTimer["u-1"];
    expect(secondTimer).toBeDefined();
    expect(secondTimer).not.toBe(firstTimer);
  });
});
