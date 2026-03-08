import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import bcrypt from "bcryptjs";
import type {
  SMTPServerSession,
  SMTPServerDataStream,
  SMTPServerAuthentication
} from "smtp-server";

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

mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSaveMailHandler,
  sendMail: mockSendMail,
  logger: mockLogger,
  getDomain: () => "test.com",
  getUserDomain: (username: string) => `${username}.test.com`,
  isValidEmail: (email: string) => email.includes("@"),
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

// Import the actual SMTP handlers after mocks are set up
import { onAuth, onData } from "./smtp";

describe("onAuth handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockGetUser.mockReset();
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
});
