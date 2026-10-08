import { describe, expect, it, jest, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import bcrypt from "bcryptjs";
import type {
  SMTPServer,
  SMTPServerSession,
  SMTPServerDataStream,
  SMTPServerAuthentication
} from "smtp-server";
import * as authRateLimit from "./auth-rate-limit";
import { restoreLeaves } from "test-helpers";

// Mock dependencies before importing project code (Bun requirement)
const mockGetUser = mock(() => Promise.resolve(null));
const mockSaveMailHandler = mock(() => Promise.resolve());
const mockSendMail = mock(() => Promise.resolve());

const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

// Import the real constant so the barrel-mock value stays in lock-step with
// the source of truth — duplicating the literal would let prod's smtp.ts
// compare against a new value while this mock still yielded the old one, and
// the guard would go silently inert in this file while tests stayed green.
import { ADMIN_RO_USERNAME } from "./read-only";

// Only mock what smtp.ts actually imports from "server": getUser, saveMailHandler, sendMail, logger.
// Do NOT add getDomain/getUserDomain/etc here — Bun's mock.module is global and persists across
// test files in the same run. Unused mocks leak into subsequent files (e.g. mails/util.test.ts),
// replacing the real implementations with mock stubs.
mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSaveMailHandler,
  sendMail: mockSendMail,
  logger: mockLogger,
  // Required, not optional — onMailFrom checks against this constant, and
  // omitting it here would leave the comparison against `undefined` and the
  // guard inert in this file while still passing every test.
  ADMIN_RO_USERNAME,
}));

const mockSimpleParser = mock(() =>
  Promise.resolve({
    messageId: "<test@example.com>",
    from: { text: "sender@example.com", value: [{ address: "sender@example.com", name: "Sender" }] },
    to: { text: "recipient@test.com", value: [{ address: "recipient@test.com", name: "Recipient" }] },
    subject: "Test Subject",
    html: "<p>Test HTML</p>",
    text: "Test text",
    date: new Date("2026-02-27T10:00:00Z"),
    attachments: []
  })
);

mock.module("mailparser", () => ({
  simpleParser: mockSimpleParser
}));

const realBcrypt = (globalThis as Record<string, unknown>).__REAL_BCRYPT as {
  compare: (password: string, hash: string) => Promise<boolean>;
  hash: (password: string, rounds: number) => Promise<string>;
  default: Record<string, unknown>;
};

// Every `bcrypt.compare` onAuth makes, as `[password, hash]`. The real
// implementation still runs underneath — a stub answering a constant would let
// the success cases pass without a working comparison. Restored for the next
// test file by `restoreLeaves` in this file's afterAll.
const compareCalls: [string, string][] = [];
const trackedCompare = (password: string, hash: string) => {
  compareCalls.push([password, hash]);
  return realBcrypt.compare(password, hash);
};

mock.module("bcryptjs", () => ({
  ...realBcrypt,
  compare: trackedCompare,
  default: { ...realBcrypt.default, compare: trackedCompare },
}));

/** A complete bcrypt digest — 22 salt chars plus 31 of hash, base64-ish alphabet. */
const BCRYPT_DIGEST = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// Stub auth-rate-limit so we can drive the rate-limit branch in onAuth without
// needing 10 real failed attempts (each takes 500ms in production code). We use
// spyOn (restored in afterAll) rather than mock.module: mock.module is process-
// global in Bun and would replace the real implementation in auth-rate-limit.test.ts
// when that file runs after this one, making its threshold assertions see the
// always-false stub. spyOn mutates the live module binding and is reverted cleanly.
const mockIsAuthRateLimited = spyOn(authRateLimit, "isAuthRateLimited").mockReturnValue(false);
const mockRecordAuthFailure = spyOn(authRateLimit, "recordAuthFailure").mockResolvedValue(false);
const mockResetAuthFailures = spyOn(authRateLimit, "resetAuthFailures").mockReturnValue(undefined);

// Note: we deliberately do NOT mock "./alarm" globally — `mock.module` is
// process-wide in Bun, and a global mock leaks into alarm.test.ts. Instead
// we let the real `sendAlarm` run and assert on its no-op behavior when
// `DISCORD_ALARM_WEBHOOK` is unset (the early return in alarm.ts:15).

// Import the actual SMTP handlers after mocks are set up
import { onAuth, onData, onMailFrom, resolveOutgoingSender, splitEnvelopeRecipients } from "./smtp";
import {
  withSmtpDataBudget,
  smtpDataBudgetCapacity,
  smtpDataBudgetInFlight,
  smtpDataBudgetWaitCeilingMs,
  _resetSmtpDataBudget
} from "./smtp-data-budget";

// Revert the auth-rate-limit spies after this file so the real implementation is
// restored for any test file that runs later (e.g. auth-rate-limit.test.ts).
afterAll(() => {
  mockIsAuthRateLimited.mockRestore();
  mockRecordAuthFailure.mockRestore();
  mockResetAuthFailures.mockRestore();
  // Restore the "server" barrel — the `mock.module("server", ...)` at the
  // top of this file replaces the export graph-wide, so `getUser` leaks
  // into any file that imports it (even `users.test.ts`'s direct import
  // from "./users", per Bun's fourth-variant hoisting behavior in
  // `reference_bun_mock_module_global_hoisting.md`). Under Linux CI file
  // orders where smtp.test.ts runs before users.test.ts, the leaked
  // `mockGetUser` returns smtp.test.ts's last `mockResolvedValue(...)`
  // (usually `{ password, getSigned: () => ({username}) }`), and
  // users.test.ts's `getUser({})` reads THAT — 16 users tests fail.
  // Preload captures the real server barrel onto `__REAL_SERVER`; this
  // afterAll re-mocks it back before the next file runs.
  const realServer = (globalThis as Record<string, unknown>).__REAL_SERVER;
  if (realServer) mock.module("server", () => realServer);
  restoreLeaves();
});

describe("onAuth handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockGetUser.mockReset();
    mockIsAuthRateLimited.mockReset();
    mockIsAuthRateLimited.mockImplementation(() => false);
    mockRecordAuthFailure.mockReset();
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(false));
    mockResetAuthFailures.mockReset();
    mockResetAuthFailures.mockImplementation(() => undefined);
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns existing session user without re-authenticating", async () => {
    const session = { user: "existing-user" } as SMTPServerSession;
    const auth = { username: "new-user", password: "password" } as SMTPServerAuthentication;

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBe("existing-user");
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects auth when user does not exist", async () => {
    const session = {} as SMTPServerSession;
    const auth = { username: "nonexistent", password: "password" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue(null);

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
  });

  it("rejects auth when password is empty", async () => {
    const hashedPw = await bcrypt.hash("correct", 10);
    const session = {} as SMTPServerSession;
    const auth = { username: "testuser", password: "" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
  });

  it("rejects auth when password is wrong", async () => {
    const hashedPw = await bcrypt.hash("correctpassword", 10);
    const session = {} as SMTPServerSession;
    const auth = { username: "testuser", password: "wrongpassword" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
  });

  it("authenticates successfully with correct credentials", async () => {
    const hashedPw = await bcrypt.hash("correctpassword", 10);
    const session = {} as SMTPServerSession;
    const auth = { username: "testuser", password: "correctpassword" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBe("testuser");
    expect(mockResetAuthFailures).toHaveBeenCalledTimes(1);
  });

  it("rejects auth when IP is rate-limited", async () => {
    mockIsAuthRateLimited.mockImplementation(() => true);
    const session = { remoteAddress: "5.6.7.8" } as SMTPServerSession;
    const auth = { username: "testuser", password: "anything" } as SMTPServerAuthentication;

    const err = await new Promise<Error | null>((resolve) => {
      onAuth!(auth, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("Too many failed authentication attempts");
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRecordAuthFailure).not.toHaveBeenCalled();
  });

  it("falls back to 'unknown' IP when remoteAddress is missing", async () => {
    const session = {} as SMTPServerSession;
    const auth = { username: "nope", password: "x" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue(null);

    await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(mockIsAuthRateLimited).toHaveBeenCalledWith("unknown");
    expect(mockRecordAuthFailure).toHaveBeenCalledWith("unknown");
  });

  it("records failure and rejects when getSigned returns falsy", async () => {
    const session = { remoteAddress: "9.9.9.9" } as SMTPServerSession;
    const auth = { username: "testuser", password: "anything" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue({
      password: "irrelevant",
      getSigned: () => null
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(result.user).toBeUndefined();
    expect(mockRecordAuthFailure).toHaveBeenCalledWith("9.9.9.9");
  });

  it("records failure on wrong-password path", async () => {
    const hashedPw = await bcrypt.hash("right", 10);
    const session = { remoteAddress: "1.1.1.1" } as SMTPServerSession;
    const auth = { username: "testuser", password: "wrong" } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: "testuser" })
    });

    await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    expect(mockRecordAuthFailure).toHaveBeenCalledWith("1.1.1.1");
    expect(mockResetAuthFailures).not.toHaveBeenCalled();
  });

  it("authenticates the read-only credential (mutation-refusal is at MAIL FROM)", async () => {
    // SMTP has only mutating gates, but authenticating admin-ro is
    // permitted so the session shape stays symmetric with HTTP/IMAP —
    // the refusal lives at MAIL FROM (below).
    const hashedPw = await bcrypt.hash("readonlypass", 10);
    const session = { remoteAddress: "10.0.0.1" } as SMTPServerSession;
    const auth = {
      username: ADMIN_RO_USERNAME,
      password: "readonlypass",
    } as SMTPServerAuthentication;
    mockGetUser.mockResolvedValue({
      password: hashedPw,
      getSigned: () => ({ username: ADMIN_RO_USERNAME }),
    });

    const result = await new Promise<{ user?: string }>((resolve) => {
      onAuth!(auth, session, (_err, data) => resolve(data || {}));
    });

    // Session.user carries the original credential so downstream gates
    // (onMailFrom) can distinguish it. Audit line names the original
    // credential.
    expect(result.user).toBe(ADMIN_RO_USERNAME);
    expect(mockResetAuthFailures).toHaveBeenCalledTimes(1);
    const readOnlyLog = mockLogger.info.mock.calls.find(
      (call) => (call[0] as string) === "SMTP AUTH success (read-only)"
    );
    expect(readOnlyLog).toBeDefined();
    expect((readOnlyLog?.[1] as Record<string, unknown>).authenticatedAs).toBe(
      ADMIN_RO_USERNAME
    );
  });
});

describe("onAuth username enumeration resistance", () => {
  const hashOf = (password: string) => realBcrypt.hash(password, 4);

  const existingUser = async () => ({
    password: await hashOf("correct-horse"),
    getSigned: () => ({ username: "testuser" }),
  });

  const drive = (username: string, password: string) =>
    new Promise<{ user?: string }>((resolve) => {
      const auth = { username, password } as SMTPServerAuthentication;
      onAuth!(auth, { remoteAddress: "203.0.113.7" } as SMTPServerSession, (_err, data) =>
        resolve(data || {})
      );
    });

  beforeEach(() => {
    compareCalls.length = 0;
    mockGetUser.mockReset();
    mockGetUser.mockImplementation(() => Promise.resolve(null));
    mockIsAuthRateLimited.mockReset();
    mockIsAuthRateLimited.mockImplementation(() => false);
    mockRecordAuthFailure.mockReset();
    mockRecordAuthFailure.mockImplementation(() => Promise.resolve(false));
    mockResetAuthFailures.mockReset();
    mockResetAuthFailures.mockImplementation(() => undefined);
  });

  it("runs a bcrypt comparison against a real digest when AUTH names no known user", async () => {
    const result = await drive("nobody", "hunter2");

    expect(result.user).toBeUndefined();
    expect(compareCalls).toHaveLength(1);
    const [password, hash] = compareCalls[0]!;
    expect(password).toBe("hunter2");
    expect(hash).toMatch(BCRYPT_DIGEST);
  });

  it("spends the same number of bcrypt rounds on an unknown user as on a wrong password", async () => {
    // The refusal is identical either way, so the round count is the only
    // observable that separates an equalised implementation from one that
    // answers an unknown username in microseconds.
    await drive("nobody", "hunter2");
    const unknownUserRounds = compareCalls.length;

    compareCalls.length = 0;
    mockGetUser.mockImplementation(existingUser);
    await drive("testuser", "hunter2");

    expect(unknownUserRounds).toBe(1);
    expect(compareCalls).toHaveLength(unknownUserRounds);
  });

  it("does not reuse a real account's digest for the unknown-user comparison", async () => {
    mockGetUser.mockImplementation(existingUser);
    await drive("testuser", "hunter2");
    const realDigest = compareCalls[0]![1];

    compareCalls.length = 0;
    mockGetUser.mockImplementation(() => Promise.resolve(null));
    await drive("nobody", "hunter2");

    expect(compareCalls[0]![1]).not.toBe(realDigest);
    expect(await realBcrypt.compare("hunter2", compareCalls[0]![1])).toBe(false);
  });

  it("runs the comparison when the stored digest is empty", async () => {
    mockGetUser.mockImplementation(() =>
      Promise.resolve({ password: "", getSigned: () => ({ username: "testuser" }) })
    );

    const result = await drive("testuser", "hunter2");

    expect(result.user).toBeUndefined();
    expect(compareCalls).toHaveLength(1);
    expect(compareCalls[0]![1]).toMatch(BCRYPT_DIGEST);
  });
});

describe("onMailFrom handler", () => {
  it("refuses MAIL FROM with 550 for the read-only session", async () => {
    // SMTP submission is a mutating action (writes a sent row, hands the
    // message to Mailgun). The read-only session's single mutating gate is
    // MAIL FROM; refuse there rather than intercepting at every command.
    const session = {
      user: ADMIN_RO_USERNAME,
      remoteAddress: "10.0.0.1",
    } as unknown as SMTPServerSession;
    const address = { address: "sender@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("READ-ONLY user cannot send");
    expect(
      (err as Error & { responseCode?: number }).responseCode
    ).toBe(550);
  });

  it("passes MAIL FROM for a non-read-only session", async () => {
    // Mutation-test the guard's discriminator: replacing the read-only
    // username with any other username must not trip it. `every(p)` on a
    // list of one user would hide a `!==` typo; asserting the pass path
    // with a distinct username is the discriminator.
    const session = {
      user: "alice",
      remoteAddress: "10.0.0.2",
    } as unknown as SMTPServerSession;
    const address = { address: "alice@test.com" } as never;

    const err = await new Promise<Error | null>((resolve) => {
      onMailFrom!(address, session, (e) => resolve(e || null));
    });

    expect(err).toBeNull();
  });
});

describe("onData handler", () => {
  const originalEnv = process.env;

  const makeStream = () => {
    const stream = {
      pipe: mock(() => stream),
      on: mock(() => stream),
      resume: mock(() => stream),
    } as unknown as SMTPServerDataStream;
    return stream;
  };

  beforeEach(() => {
    mockSaveMailHandler.mockReset();
    mockSendMail.mockReset();
    mockSimpleParser.mockReset();
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<test@example.com>",
        from: { text: "sender@example.com", value: [{ address: "sender@example.com" }] },
        to: { text: "recipient@test.com", value: [{ address: "recipient@test.com" }] },
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
        text: "Test text",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns error when EMAIL_DOMAIN is not set", async () => {
    delete process.env.EMAIL_DOMAIN;
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "sender@test.com" },
        rcptTo: [{ address: "recipient@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    const err = await new Promise<Error | null>((resolve) => {
      onData(stream, session, (e) => resolve(e || null));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("Email service not configured");
  });

  it("routes incoming email to saveMailHandler", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("routes outgoing email to sendMail", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("propagates parser failure on incoming path", async () => {
    mockSimpleParser.mockImplementation(() =>
      Promise.reject(new Error("malformed mail"))
    );
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("malformed mail");
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
  });

  it("rejects outgoing path when session.user is missing", async () => {
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "spoofer@test.com" },
        rcptTo: [{ address: "victim@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("User not authenticated");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("rejects outgoing path when getUser returns null", async () => {
    const stream = makeStream();
    const session = {
      user: "ghost",
      envelope: {
        mailFrom: { address: "ghost@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue(null);

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("User not authenticated");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("propagates parser failure on outgoing path", async () => {
    mockSimpleParser.mockImplementation(() =>
      Promise.reject(new Error("outgoing parse failure"))
    );
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("outgoing parse failure");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("wraps non-Error rejection in Error on outgoing path", async () => {
    mockSimpleParser.mockImplementation(() => Promise.reject("plain string"));
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("plain string");
  });

  it("defaults sender to 'admin' when mailFrom address has no local part", async () => {
    // To reach onDataOutgoing, mailFrom must be a non-boolean with an address
    // that endsWith @EMAIL_DOMAIN. An address of "@test.com" satisfies that and
    // also exercises the `"" || "admin"` fallback inside the handler.
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "@test.com" },
        rcptTo: [{ address: "recipient@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });

    // Parser body returns from.text undefined → senderFullName falls back to sender ("admin")
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<o@example.com>",
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendMail.mock.calls[0];
    // sendMail(signedUser, mailData) — mailData is the 2nd arg
    const mailData = callArgs[1] as { sender: string; senderFullName: string };
    expect(mailData.sender).toBe("admin");
    expect(mailData.senderFullName).toBe("admin");
  });

  it("sends as the same-domain recipient named in the submission", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "recipient@other.com" }, { address: "sales@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<dyn@example.com>",
        from: {
          text: "Admin <admin@test.com>",
          value: [{ address: "admin@test.com", name: "Admin" }]
        },
        to: {
          text: "recipient@other.com",
          value: [{ address: "recipient@other.com", name: "" }]
        },
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailData = mockSendMail.mock.calls[0][1] as {
      sender: string;
      to: string;
    };
    expect(mailData.sender).toBe("sales");
    expect(mailData.to).toBe("recipient@other.com");
    expect((mailData as { bcc?: string }).bcc).toBeUndefined();
    expect((mailData as { senderFullName: string }).senderFullName).toBe("Admin");
  });

  it("leaves a To recipient of the user's domain addressed", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "bob@test.com" }, { address: "friend@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<addressed@example.com>",
        from: {
          text: "Admin <admin@test.com>",
          value: [{ address: "admin@test.com", name: "Admin" }]
        },
        to: {
          text: "bob@test.com, friend@other.com",
          value: [{ address: "bob@test.com" }, { address: "friend@other.com" }]
        },
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    const mailData = mockSendMail.mock.calls[0][1] as {
      sender: string;
      to: string;
    };
    expect(mailData.sender).toBe("admin");
    expect(mailData.to).toBe("bob@test.com,friend@other.com");
  });

  it("reads To recipients out of an RFC 5322 address group", async () => {
    const stream = makeStream();
    const session = {
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: [{ address: "bob@test.com" }, { address: "friend@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    mockGetUser.mockResolvedValue({
      getSigned: () => ({ username: "admin" })
    });
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<group@example.com>",
        from: {
          text: "Admin <admin@test.com>",
          value: [{ address: "admin@test.com", name: "Admin" }]
        },
        to: {
          text: "Team: bob@test.com, friend@other.com;",
          value: [
            {
              name: "Team",
              group: [
                { address: "bob@test.com", name: "" },
                { address: "friend@other.com", name: "" }
              ]
            }
          ]
        },
        subject: "Hello",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    const mailData = mockSendMail.mock.calls[0][1] as {
      sender: string;
      to: string;
    };
    expect(mailData.sender).toBe("admin");
    expect(mailData.to).toBe("bob@test.com,friend@other.com");
  });

  it("maps attachments through the parsed attachment array", async () => {
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<att@example.com>",
        from: { text: "external@other.com", value: [{ address: "external@other.com" }] },
        to: { text: "user@test.com", value: [{ address: "user@test.com" }] },
        subject: "Has attachment",
        html: "<p>body</p>",
        text: "body",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: [
          {
            filename: "receipt.pdf",
            contentType: "application/pdf",
            content: Buffer.from("pdf"),
            size: 3
          },
          {
            // missing filename → falls back to "attachment"
            contentType: "image/png",
            content: Buffer.from("png"),
            size: 3
          }
        ]
      })
    );
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(stream, session, (e) => resolve(e));
    });

    expect(err).toBeUndefined();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
    const mailArg = mockSaveMailHandler.mock.calls[0]![1] as {
      attachments: Array<{ filename: string; contentType: string; size: number }>;
    };
    expect(mailArg.attachments).toHaveLength(2);
    expect(mailArg.attachments[0]!.filename).toBe("receipt.pdf");
    expect(mailArg.attachments[1]!.filename).toBe("attachment");
  });

  const outgoingSession = (rcptTo: string[]) =>
    ({
      user: "admin",
      envelope: {
        mailFrom: { address: "admin@test.com" },
        rcptTo: rcptTo.map((address) => ({ address }))
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SMTPServerSession;

  const parseAs = (headers: {
    to?: { address?: string; group?: { address: string }[] }[];
    cc?: { address?: string; group?: { address: string }[] }[];
  }) => {
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<test@example.com>",
        from: { text: "admin@test.com", value: [{ address: "admin@test.com" }] },
        to: headers.to && { text: "", value: headers.to },
        cc: headers.cc && { text: "", value: headers.cc },
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
        text: "Test text",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );
  };

  const driveOutgoing = async (session: SMTPServerSession) => {
    mockGetUser.mockResolvedValue({ getSigned: () => ({ username: "admin" }) });
    const err = await new Promise<Error | null | undefined>((resolve) => {
      onData(makeStream(), session, (e) => resolve(e));
    });
    expect(err).toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    return mockSendMail.mock.calls[0][1];
  };

  it("keeps an envelope recipient the To: header omits out of the To field", async () => {
    parseAs({ to: [{ address: "visible@other.com" }] });
    const mailData = await driveOutgoing(
      outgoingSession(["visible@other.com", "hidden@other.com"])
    );

    expect(mailData.to).toBe("visible@other.com");
    expect(mailData.bcc).toBe("hidden@other.com");
    expect(mailData.cc).toBeUndefined();
  });

  it("routes a Cc: header recipient to cc, not to to or bcc", async () => {
    parseAs({
      to: [{ address: "visible@other.com" }],
      cc: [{ address: "copied@other.com" }]
    });
    const mailData = await driveOutgoing(
      outgoingSession(["visible@other.com", "copied@other.com", "hidden@other.com"])
    );

    expect(mailData.to).toBe("visible@other.com");
    expect(mailData.cc).toBe("copied@other.com");
    expect(mailData.bcc).toBe("hidden@other.com");
  });

  it("sends a header-less submission entirely as bcc", async () => {
    parseAs({});
    const mailData = await driveOutgoing(
      outgoingSession(["one@other.com", "two@other.com"])
    );

    expect(mailData.to).toBe("");
    expect(mailData.bcc).toBe("one@other.com,two@other.com");
  });

  it("reads addresses out of an RFC 5322 group in the To: header", async () => {
    // `To: Team: a@x, b@x;` — mailparser nests the members under value[0].group
    // and leaves value[0].address undefined.
    parseAs({
      to: [{ group: [{ address: "a@other.com" }, { address: "b@other.com" }] }]
    });
    const mailData = await driveOutgoing(
      outgoingSession(["a@other.com", "b@other.com", "hidden@other.com"])
    );

    expect(mailData.to).toBe("a@other.com,b@other.com");
    expect(mailData.bcc).toBe("hidden@other.com");
  });

  it("does not invoke callback when neither incoming nor outgoing matches", async () => {
    // Both addresses outside EMAIL_DOMAIN — neither branch fires, cb stays uncalled.
    const stream = makeStream();
    const session = {
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "external@other.com" }]
      },
      remoteAddress: "1.2.3.4"
    } as unknown as SMTPServerSession;

    let cbCalled = false;
    onData(stream, session, () => {
      cbCalled = true;
    });
    // Give microtasks a chance — nothing should run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cbCalled).toBe(false);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe("splitEnvelopeRecipients", () => {
  it("assigns each envelope recipient by the header that names it", () => {
    const split = splitEnvelopeRecipients(
      ["a@x.com", "b@x.com", "c@x.com"],
      ["a@x.com"],
      ["b@x.com"]
    );
    expect(split).toEqual({ to: ["a@x.com"], cc: ["b@x.com"], bcc: ["c@x.com"] });
  });

  it("matches a header address to an envelope address case-insensitively", () => {
    const split = splitEnvelopeRecipients(["Alice@X.com"], ["alice@x.com"], []);
    expect(split).toEqual({ to: ["Alice@X.com"], cc: [], bcc: [] });
  });

  it("ignores a header address that the envelope never named", () => {
    const split = splitEnvelopeRecipients(
      ["real@x.com"],
      ["real@x.com", "forged@x.com"],
      []
    );
    expect(split).toEqual({ to: ["real@x.com"], cc: [], bcc: [] });
  });

  it("assigns an address named by both headers to To, not Cc", () => {
    const split = splitEnvelopeRecipients(
      ["dup@x.com"],
      ["dup@x.com"],
      ["dup@x.com"]
    );
    expect(split).toEqual({ to: ["dup@x.com"], cc: [], bcc: [] });
  });

  it("returns three empty lists for an empty envelope", () => {
    expect(splitEnvelopeRecipients([], ["a@x.com"], ["b@x.com"])).toEqual({
      to: [],
      cc: [],
      bcc: []
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// registerListeners is not exported, but its behavior is reachable by
// driving initializeSmtp with a mocked SMTPServer constructor. We mock the
// smtp-server module so each `new SMTPServer(...)` returns a controllable
// EventEmitter-like stub, then replay the error/close events we care about.
// ───────────────────────────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

interface FakeServer {
  on: (event: string, listener: Listener) => void;
  listen: (port: number, callback: () => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  listeners: Map<string, Listener[]>;
  // The real SMTPServer tracks its live connections here; the eviction sweep
  // reads it, so the stub carries one too.
  connections: Set<unknown>;
}

const createdServers: FakeServer[] = [];

const makeFakeServer = (): FakeServer => {
  const listeners = new Map<string, Listener[]>();
  const server: FakeServer = {
    listeners,
    connections: new Set<unknown>(),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    },
    listen(_port, callback) {
      // Fire callback synchronously so initializeSmtp's promise resolves.
      callback();
    },
    emit(event, ...args) {
      (listeners.get(event) || []).forEach((fn) => fn(...args));
    }
  };
  return server;
};

mock.module("smtp-server", () => ({
  SMTPServer: class {
    constructor(_opts: unknown) {
      const fake = makeFakeServer();
      createdServers.push(fake);
      return fake as unknown as SMTPServer;
    }
  }
}));

// Lazy import — must come after the smtp-server mock above so initializeSmtp
// sees the fake constructor.
const loadInitializeSmtp = async () => {
  const mod = await import("./smtp");
  return mod.initializeSmtp;
};

describe("registerListeners error handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    createdServers.length = 0;
    mockLogger.error.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    process.env = { ...originalEnv };
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    // Keep DISCORD_ALARM_WEBHOOK unset so real `sendAlarm` is a no-op (alarm.ts:15).
    delete process.env.DISCORD_ALARM_WEBHOOK;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const bootSingleServer = async () => {
    const initializeSmtp = await loadInitializeSmtp();
    // Without SSL configured, initializeSmtp only spins up one server on SMTP_PORT.
    await initializeSmtp();
    expect(createdServers.length).toBeGreaterThan(0);
    return createdServers[0]!;
  };

  it("suppresses the alarm for TLS handshake function names, but still logs a warning", async () => {
    const server = await bootSingleServer();
    server.emit("error", new Error("tls_early_post_process_client_hello: unsupported protocol"));
    server.emit("error", new Error("extract_keyshares: bad key share"));
    server.emit("error", new Error("tls_choose_sigalg: no suitable signature algorithm"));
    server.emit("error", new Error("Socket closed before TLS handshake"));
    server.emit("error", new Error("read ECONNRESET"));
    server.emit("error", new Error("TLS handshake timeout"));
    server.emit("error", new Error("write ECONNRESET"));
    server.emit("error", new Error("write EPIPE"));

    expect(mockLogger.error).not.toHaveBeenCalled();
    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes("SMTP Server")).length).toBe(8);
  });

  it("logs error on non-suppressible failures", async () => {
    const server = await bootSingleServer();
    server.emit("error", new Error("unexpected internal failure"));

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const errArgs = mockLogger.error.mock.calls[0]!;
    expect(String(errArgs[0])).toContain("SMTP Server");
  });

  it("logs an info line on server close", async () => {
    const server = await bootSingleServer();
    mockLogger.info.mockReset();
    server.emit("close");
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(String(mockLogger.info.mock.calls[0]![0])).toContain("closed");
  });
});

describe("initializeSmtp configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    createdServers.length = 0;
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
    process.env = { ...originalEnv };
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    delete process.env.SMTP_PORT;
    delete process.env.SMTPS_PORT;
    delete process.env.SMTP_SUBMISSION_PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("starts one plaintext server when SSL is not configured", async () => {
    const initializeSmtp = await loadInitializeSmtp();
    const servers = await initializeSmtp();

    expect(servers.length).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalled();
    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes("not configured"))).toBe(true);
  });

  it("warns and falls back to plaintext when SSL files are unreadable", async () => {
    process.env.SSL_CERTIFICATE = "/nonexistent/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/nonexistent/key.pem";
    const initializeSmtp = await loadInitializeSmtp();
    const servers = await initializeSmtp();

    expect(servers.length).toBe(1);
    // Configured-but-unusable TLS logs at ERROR (and alarms), not WARN: the
    // process keeps serving cleartext, so nothing else pages for it.
    const errors = mockLogger.error.mock.calls.map((c) => String(c[0]));
    expect(errors.some((m) => m.includes("SSL certificate files not readable"))).toBe(true);
  });

  it("starts three servers (SMTP + SMTPS + submission) when SSL files exist", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = mkdtempSync(join(tmpdir(), "smtp-ssl-test-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, "DUMMY CERT");
    writeFileSync(keyPath, "DUMMY KEY");
    process.env.SSL_CERTIFICATE = certPath;
    process.env.SSL_CERTIFICATE_KEY = keyPath;

    try {
      const initializeSmtp = await loadInitializeSmtp();
      const servers = await initializeSmtp();

      // One plaintext (25) + SMTPS (465) + submission (587) = 3
      expect(servers.length).toBe(3);
      // The "SSL certificate files not found" warning should NOT fire here.
      const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((m) => m.includes("SSL certificate files not found"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses custom SMTP_PORT / SMTPS_PORT / SMTP_SUBMISSION_PORT env values", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = mkdtempSync(join(tmpdir(), "smtp-port-test-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, "DUMMY CERT");
    writeFileSync(keyPath, "DUMMY KEY");
    process.env.SSL_CERTIFICATE = certPath;
    process.env.SSL_CERTIFICATE_KEY = keyPath;
    process.env.SMTP_PORT = "2525";
    process.env.SMTPS_PORT = "4465";
    process.env.SMTP_SUBMISSION_PORT = "5587";

    try {
      const initializeSmtp = await loadInitializeSmtp();
      const servers = await initializeSmtp();
      expect(servers.length).toBe(3);
      // Confirm logger.info recorded each port in its "listening on port N" message.
      const infos = mockLogger.info.mock.calls.map((c) => String(c[0]));
      expect(infos.some((m) => m.includes("2525"))).toBe(true);
      expect(infos.some((m) => m.includes("4465"))).toBe(true);
      expect(infos.some((m) => m.includes("5587"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOutgoingSender", () => {
  const resolve = (
    from: { header?: string; envelope?: string },
    recipients: string[],
    addressedTo: string[] = []
  ) => resolveOutgoingSender("admin", "test.com", from, recipients, addressedTo);

  it("promotes the first same-domain recipient to sender and drops it", () => {
    expect(
      resolve({ header: "admin@test.com", envelope: "admin@test.com" }, [
        "outside@other.com",
        "sales@test.com",
        "later@other.com"
      ])
    ).toEqual({
      sender: "sales",
      recipients: ["outside@other.com", "later@other.com"]
    });
  });

  it("selects only the first same-domain recipient and keeps the rest", () => {
    expect(
      resolve({ envelope: "admin@test.com" }, [
        "sales@test.com",
        "support@test.com"
      ])
    ).toEqual({ sender: "sales", recipients: ["support@test.com"] });
  });

  it("keeps a From that already names another account of the domain", () => {
    expect(
      resolve({ header: "sales@test.com", envelope: "admin@test.com" }, [
        "outside@other.com",
        "support@test.com"
      ])
    ).toEqual({
      sender: "sales",
      recipients: ["outside@other.com", "support@test.com"]
    });
  });

  it("treats the login account among the recipients as a real recipient", () => {
    expect(
      resolve({ envelope: "admin@test.com" }, [
        "outside@other.com",
        "admin@test.com"
      ])
    ).toEqual({
      sender: "admin",
      recipients: ["outside@other.com", "admin@test.com"]
    });
  });

  it("matches the domain case-insensitively and normalizes the account", () => {
    expect(
      resolve({ envelope: "Admin@TEST.com" }, [
        "Sales@Test.com",
        "outside@other.com"
      ])
    ).toEqual({ sender: "sales", recipients: ["outside@other.com"] });
  });

  it("ignores a From header outside the user domain and falls back to the envelope", () => {
    expect(
      resolve({ header: "spoofed@evil.com", envelope: "admin@test.com" }, [
        "outside@other.com"
      ])
    ).toEqual({ sender: "admin", recipients: ["outside@other.com"] });
  });

  it("never lets a From header outside the user domain supply the sender", () => {
    expect(resolve({ header: "ceo@irs.gov" }, ["victim@other.com"])).toEqual({
      sender: "admin",
      recipients: ["victim@other.com"]
    });
    expect(
      resolve({ header: "ceo@irs.gov", envelope: "@test.com" }, [
        "victim@other.com"
      ])
    ).toEqual({ sender: "admin", recipients: ["victim@other.com"] });
  });

  it("lowercases a sender taken from the envelope", () => {
    expect(
      resolve({ envelope: "Bob@Test.com" }, ["outside@other.com"])
    ).toEqual({ sender: "bob", recipients: ["outside@other.com"] });
  });

  it("leaves a To recipient of the user's domain addressed, not promoted", () => {
    expect(
      resolve(
        { envelope: "admin@test.com" },
        ["bob@test.com", "friend@other.com"],
        ["bob@test.com", "friend@other.com"]
      )
    ).toEqual({
      sender: "admin",
      recipients: ["bob@test.com", "friend@other.com"]
    });
  });

  it("promotes a Cc account while a To account of the same domain stays addressed", () => {
    expect(
      resolve(
        { envelope: "admin@test.com" },
        ["bob@test.com", "sales@test.com"],
        ["bob@test.com"]
      )
    ).toEqual({ sender: "sales", recipients: ["bob@test.com"] });
  });

  it("keeps a lone same-domain recipient rather than emptying the recipient list", () => {
    expect(resolve({ envelope: "admin@test.com" }, ["sales@test.com"])).toEqual({
      sender: "admin",
      recipients: ["sales@test.com"]
    });
  });

  it("does not read a local part out of a two-at address", () => {
    expect(
      resolve({ header: "sales@evil.com@test.com", envelope: "admin@test.com" }, [
        "outside@other.com"
      ])
    ).toEqual({ sender: "admin", recipients: ["outside@other.com"] });
  });

  it("falls back to the username when no address carries a local part", () => {
    expect(resolve({ envelope: "@test.com" }, ["outside@other.com"])).toEqual({
      sender: "admin",
      recipients: ["outside@other.com"]
    });
  });

  it("scopes selection to the caller's own domain, not the bare mail domain", () => {
    expect(
      resolveOutgoingSender(
        "alice",
        "alice.test.com",
        { envelope: "alice@alice.test.com" },
        ["outside@other.com", "team@alice.test.com", "admin@test.com"],
        []
      )
    ).toEqual({
      sender: "team",
      recipients: ["outside@other.com", "admin@test.com"]
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Credential eviction: a rotated password has to reach connections that
// authenticated before it, because SMTP authenticates once per connection and
// never re-derives the grant from the stored hash.
// ───────────────────────────────────────────────────────────────────────────

interface StubConnection {
  session: { user?: string };
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

const makeConnection = (user?: string): StubConnection => ({
  session: { user },
  send: mock(() => {}),
  close: mock(() => {})
});

describe("evictSmtpConnections", () => {
  const originalEnv = process.env;
  let evictSmtpConnections: (username: string) => number;
  let server: FakeServer;

  beforeEach(async () => {
    createdServers.length = 0;
    process.env = { ...originalEnv };
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;
    const initializeSmtp = await loadInitializeSmtp();
    await initializeSmtp();
    server = createdServers[0]!;
    evictSmtpConnections = (await import("./smtp-registry")).evictSmtpConnections;
  });

  afterEach(() => {
    // "close" is what drops the server from the registry, so emitting it keeps
    // this file's fakes out of later suites' sweeps.
    createdServers.forEach((created) => created.emit("close"));
    process.env = originalEnv;
  });

  it("closes only the connections authenticated as the rotated username", () => {
    const alice = makeConnection("alice");
    const otherAlice = makeConnection("alice");
    const bob = makeConnection("bob");
    const anonymous = makeConnection(undefined);
    [alice, otherAlice, bob, anonymous].forEach((c) => server.connections.add(c));

    expect(evictSmtpConnections("alice")).toBe(2);

    [alice, otherAlice].forEach((c) => {
      expect(c.send).toHaveBeenCalledTimes(1);
      expect(c.send.mock.calls[0]![0]).toBe(421);
      expect(c.close).toHaveBeenCalledTimes(1);
    });
    expect(bob.close).not.toHaveBeenCalled();
    expect(anonymous.close).not.toHaveBeenCalled();
  });

  it("keeps sweeping after a connection refuses teardown", () => {
    const refuses = makeConnection("alice");
    refuses.close = mock(() => {
      throw new Error("socket already gone");
    });
    const healthy = makeConnection("alice");
    [refuses, healthy].forEach((c) => server.connections.add(c));

    expect(evictSmtpConnections("alice")).toBe(1);
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });

  it("reports nothing evicted when no connection matches", () => {
    server.connections.add(makeConnection("bob"));
    expect(evictSmtpConnections("alice")).toBe(0);
  });

  it("stops reaching a server that has closed", () => {
    const alice = makeConnection("alice");
    server.connections.add(alice);

    server.emit("close");

    expect(evictSmtpConnections("alice")).toBe(0);
    expect(alice.close).not.toHaveBeenCalled();
  });
});


/**
 * Proves the DATA budget is wired into `onData` itself, not merely correct in
 * isolation (`smtp-data-budget.test.ts` covers the semaphore in a vacuum).
 * Every assertion here drives SEVERAL transactions at once, because a test
 * that drives one cannot distinguish a bounded listener from an unbounded one
 * — the defect is only visible in the aggregate.
 */
describe("onData DATA budget wiring", () => {
  const CAP = smtpDataBudgetCapacity();
  const originalEnv = process.env;

  const makeStream = () => {
    const stream = {
      pipe: mock(() => stream),
      on: mock(() => stream),
      resume: mock(() => stream),
    } as unknown as SMTPServerDataStream;
    return stream;
  };

  const incomingSession = () =>
    ({
      envelope: {
        mailFrom: { address: "external@other.com" },
        rcptTo: [{ address: "user@test.com" }]
      },
      remoteAddress: "1.2.3.4"
    }) as unknown as SMTPServerSession;

  const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  const nextTick = () => new Promise<void>((r) => setImmediate(r));

  beforeEach(() => {
    _resetSmtpDataBudget();
    mockSaveMailHandler.mockReset();
    mockSaveMailHandler.mockImplementation(() => Promise.resolve());
    mockSimpleParser.mockReset();
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetSmtpDataBudget();
  });

  it("holds concurrent transactions to the capacity and still accepts them all", async () => {
    const gates: Array<ReturnType<typeof defer>> = [];
    let parsing = 0;
    let peakParsing = 0;
    mockSimpleParser.mockImplementation(() => {
      parsing++;
      peakParsing = Math.max(peakParsing, parsing);
      const gate = defer();
      gates.push(gate);
      return gate.promise.then(() => {
        parsing--;
        return { attachments: [] };
      });
    });

    const total = CAP + 3;
    const settled = Array.from(
      { length: total },
      () =>
        new Promise<Error | null | undefined>((resolve) => {
          onData(makeStream(), incomingSession(), resolve);
        })
    );
    await nextTick();

    // The bound: `maxClients` would have let all `total` parse at once.
    expect(peakParsing).toBe(CAP);

    // Drain the queue — each release admits the next waiter, so the gate list
    // grows as we go and has to be walked rather than snapshotted.
    for (let drained = 0; drained < total; drained++) {
      gates[drained].resolve();
      await nextTick();
    }

    const errors = await Promise.all(settled);
    expect(errors.filter(Boolean)).toEqual([]);
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(total);
    expect(peakParsing).toBe(CAP);
    expect(smtpDataBudgetInFlight()).toBe(0);
  });

  it("refuses with 421 and drains the stream when no slot frees up in time", async () => {
    const holders = Array.from({ length: CAP }, () => defer());
    const held = holders.map((gate) => withSmtpDataBudget(() => gate.promise));
    await nextTick();

    const stream = makeStream();
    jest.useFakeTimers();
    let err: Error | null | undefined;
    try {
      const refused = new Promise<Error | null | undefined>((resolve) => {
        onData(stream, incomingSession(), resolve);
      });
      jest.advanceTimersByTime(smtpDataBudgetWaitCeilingMs() + 1);
      err = await refused;
    } finally {
      jest.useRealTimers();
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { responseCode?: number }).responseCode).toBe(421);
    // Without the drain `smtp-server` waits for an `end` the stream cannot
    // emit, and the peer reads nothing until its own socket timeout.
    expect(stream.resume).toHaveBeenCalledTimes(1);
    expect(mockSaveMailHandler).not.toHaveBeenCalled();

    holders.forEach((gate) => gate.resolve());
    await Promise.all(held);
  });

  it("frees the slot when a transaction fails, so the next one is admitted", async () => {
    mockSimpleParser.mockImplementationOnce(() => Promise.reject(new Error("bad message")));
    mockSimpleParser.mockImplementation(() => Promise.resolve({ attachments: [] }));

    const first = await new Promise<Error | null | undefined>((resolve) => {
      onData(makeStream(), incomingSession(), resolve);
    });
    expect(first).toBeInstanceOf(Error);
    expect(smtpDataBudgetInFlight()).toBe(0);

    const second = await new Promise<Error | null | undefined>((resolve) => {
      onData(makeStream(), incomingSession(), resolve);
    });
    expect(second).toBeFalsy();
    expect(mockSaveMailHandler).toHaveBeenCalledTimes(1);
  });
});
