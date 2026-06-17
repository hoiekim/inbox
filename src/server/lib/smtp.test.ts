import { describe, expect, it, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import bcrypt from "bcryptjs";
import type {
  SMTPServer,
  SMTPServerSession,
  SMTPServerDataStream,
  SMTPServerAuthentication
} from "smtp-server";
import * as authRateLimit from "./auth-rate-limit";

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

// Only mock what smtp.ts actually imports from "server": getUser, saveMailHandler, sendMail, logger.
// Do NOT add getDomain/getUserDomain/etc here — Bun's mock.module is global and persists across
// test files in the same run. Unused mocks leak into subsequent files (e.g. mails/util.test.ts),
// replacing the real implementations with mock stubs.
mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSaveMailHandler,
  sendMail: mockSendMail,
  logger: mockLogger,
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
import { onAuth, onData } from "./smtp";

// Revert the auth-rate-limit spies after this file so the real implementation is
// restored for any test file that runs later (e.g. auth-rate-limit.test.ts).
afterAll(() => {
  mockIsAuthRateLimited.mockRestore();
  mockRecordAuthFailure.mockRestore();
  mockResetAuthFailures.mockRestore();
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
});

describe("onData handler", () => {
  const originalEnv = process.env;

  const makeStream = () => {
    const stream = {
      pipe: mock(() => stream),
      on: mock(() => stream),
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
}

const createdServers: FakeServer[] = [];

const makeFakeServer = (): FakeServer => {
  const listeners = new Map<string, Listener[]>();
  const server: FakeServer = {
    listeners,
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

  it("suppresses errors from TLS handshake function names", async () => {
    const server = await bootSingleServer();
    server.emit("error", new Error("tls_early_post_process_client_hello: unsupported protocol"));
    server.emit("error", new Error("extract_keyshares: bad key share"));
    server.emit("error", new Error("tls_choose_sigalg: no suitable signature algorithm"));
    server.emit("error", new Error("Socket closed before TLS handshake"));
    server.emit("error", new Error("read ECONNRESET"));

    expect(mockLogger.error).not.toHaveBeenCalled();
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

  it("warns and falls back to plaintext when SSL files are missing", async () => {
    process.env.SSL_CERTIFICATE = "/nonexistent/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/nonexistent/key.pem";
    const initializeSmtp = await loadInitializeSmtp();
    const servers = await initializeSmtp();

    expect(servers.length).toBe(1);
    const warnings = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes("SSL certificate files not found"))).toBe(true);
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
