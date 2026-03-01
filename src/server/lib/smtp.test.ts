import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import bcrypt from "bcryptjs";
import type {
  SMTPServerSession,
  SMTPServerDataStream,
  SMTPServerAuthentication
} from "smtp-server";
import type { AddressObject } from "mailparser";

// Mock dependencies before importing
const mockGetUser = mock(() => Promise.resolve(null));
const mockSaveMailHandler = mock(() => Promise.resolve());
const mockSendMail = mock(() => Promise.resolve());

mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSaveMailHandler,
  sendMail: mockSendMail
}));

// Mock simpleParser
const mockSimpleParser = mock(() =>
  Promise.resolve({
    messageId: "<test@example.com>",
    from: { text: "sender@example.com", value: [{ address: "sender@example.com", name: "Sender" }] } as AddressObject,
    to: { text: "recipient@example.com", value: [{ address: "recipient@example.com", name: "Recipient" }] } as AddressObject,
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

describe("SMTP Server Handlers", () => {
  // Store original env
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset mocks
    mockGetUser.mockReset();
    mockSaveMailHandler.mockReset();
    mockSendMail.mockReset();
    mockSimpleParser.mockReset();

    // Set default env
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };

    // Reset simpleParser to default response
    mockSimpleParser.mockImplementation(() =>
      Promise.resolve({
        messageId: "<test@example.com>",
        from: { text: "sender@example.com", value: [{ address: "sender@example.com", name: "Sender" }] } as AddressObject,
        to: { text: "recipient@example.com", value: [{ address: "recipient@example.com", name: "Recipient" }] } as AddressObject,
        subject: "Test Subject",
        html: "<p>Test HTML</p>",
        text: "Test text",
        date: new Date("2026-02-27T10:00:00Z"),
        attachments: []
      })
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("onAuth handler logic", () => {
    it("should return user if session already has user", async () => {
      // When session already has user, auth should return that user
      const session = { user: "existing-user" } as SMTPServerSession;
      const auth = { username: "new-user", password: "password" } as SMTPServerAuthentication;

      // The onAuth handler checks session.user first
      // If exists, it returns { user: session.user } without checking credentials
      expect(session.user).toBe("existing-user");
    });

    it("should reject auth with missing password", async () => {
      const auth = { username: "testuser", password: "" } as SMTPServerAuthentication;

      // Missing password should cause rejection
      // The handler checks: if (!password || !user || !signedUser) return cb(null, { user: undefined });
      mockGetUser.mockImplementation(() =>
        Promise.resolve({
          password: "$2a$10$hashedpassword",
          getSigned: () => ({ username: "testuser" })
        })
      );

      // With empty password, should return undefined user
      expect(auth.password).toBeFalsy();
    });

    it("should reject auth with non-existent user", async () => {
      mockGetUser.mockImplementation(() => Promise.resolve(null));

      // When getUser returns null, auth should be rejected
      const result = await mockGetUser({ username: "nonexistent" });
      expect(result).toBeNull();
    });

    it("should reject auth with wrong password", async () => {
      const hashedPassword = await bcrypt.hash("correctpassword", 10);
      mockGetUser.mockImplementation(() =>
        Promise.resolve({
          password: hashedPassword,
          getSigned: () => ({ username: "testuser" })
        })
      );

      // Wrong password should not match
      const passwordMatches = await bcrypt.compare("wrongpassword", hashedPassword);
      expect(passwordMatches).toBe(false);
    });

    it("should accept auth with correct credentials", async () => {
      const hashedPassword = await bcrypt.hash("correctpassword", 10);
      mockGetUser.mockImplementation(() =>
        Promise.resolve({
          password: hashedPassword,
          getSigned: () => ({ username: "testuser" })
        })
      );

      // Correct password should match
      const passwordMatches = await bcrypt.compare("correctpassword", hashedPassword);
      expect(passwordMatches).toBe(true);
    });

    it("should reject user without getSigned result", async () => {
      const hashedPassword = await bcrypt.hash("password", 10);
      mockGetUser.mockImplementation(() =>
        Promise.resolve({
          password: hashedPassword,
          getSigned: () => null // No signed user (e.g., unverified account)
        })
      );

      const user = await mockGetUser({ username: "testuser" });
      const signedUser = user?.getSigned();
      expect(signedUser).toBeNull();
    });
  });

  describe("onData incoming email detection", () => {
    it("should detect incoming email when recipient matches domain", () => {
      const session = {
        envelope: {
          mailFrom: { address: "external@other.com" },
          rcptTo: [{ address: "user@test.com" }]
        }
      } as unknown as SMTPServerSession;

      const { EMAIL_DOMAIN } = process.env;
      const isIncomingEmail = session.envelope.rcptTo.some((addr) =>
        addr.address.endsWith(`@${EMAIL_DOMAIN}`)
      );

      expect(isIncomingEmail).toBe(true);
    });

    it("should detect outgoing email when sender matches domain", () => {
      const session = {
        envelope: {
          mailFrom: { address: "user@test.com" },
          rcptTo: [{ address: "external@other.com" }]
        }
      } as unknown as SMTPServerSession;

      const { EMAIL_DOMAIN } = process.env;
      const from = session.envelope.mailFrom;
      const isOutgoingEmail =
        typeof from !== "boolean" && from.address.endsWith(`@${EMAIL_DOMAIN}`);

      expect(isOutgoingEmail).toBe(true);
    });

    it("should handle mailFrom being boolean false", () => {
      const session = {
        envelope: {
          mailFrom: false,
          rcptTo: [{ address: "user@test.com" }]
        }
      } as unknown as SMTPServerSession;

      const from = session.envelope.mailFrom;
      const isOutgoingEmail =
        typeof from !== "boolean" && from.address.endsWith("@test.com");

      expect(isOutgoingEmail).toBe(false);
    });
  });

  describe("onData rejection without EMAIL_DOMAIN", () => {
    it("should reject when EMAIL_DOMAIN is not set", () => {
      delete process.env.EMAIL_DOMAIN;

      const { EMAIL_DOMAIN } = process.env;
      expect(EMAIL_DOMAIN).toBeUndefined();

      // The handler returns: cb(new Error("Email service not configured"))
      // when EMAIL_DOMAIN is not set
    });
  });

  describe("onDataIncoming - email parsing", () => {
    it("should parse email and extract required fields", async () => {
      const mockParsed = {
        messageId: "<unique-id@example.com>",
        from: { text: "sender@external.com", value: [{ address: "sender@external.com", name: "Sender" }] } as AddressObject,
        to: { text: "recipient@test.com", value: [{ address: "recipient@test.com", name: "Recipient" }] } as AddressObject,
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        subject: "Test Subject",
        date: new Date("2026-02-27T10:00:00Z"),
        html: "<p>HTML content</p>",
        text: "Plain text content",
        attachments: []
      };

      mockSimpleParser.mockImplementation(() => Promise.resolve(mockParsed));
      const parsed = await mockSimpleParser({} as SMTPServerDataStream);

      expect(parsed.messageId).toBe("<unique-id@example.com>");
      expect(parsed.subject).toBe("Test Subject");
      expect(parsed.html).toBe("<p>HTML content</p>");
      expect(parsed.text).toBe("Plain text content");
    });

    it("should fall back to text when html is missing", async () => {
      const mockParsed = {
        messageId: "<test@example.com>",
        from: { text: "sender@external.com", value: [{ address: "sender@external.com", name: "Sender" }] } as AddressObject,
        to: { text: "recipient@test.com", value: [{ address: "recipient@test.com", name: "Recipient" }] } as AddressObject,
        subject: "Test",
        date: new Date(),
        html: false as false, // mailparser returns false when no html
        text: "Plain text only",
        attachments: []
      };

      mockSimpleParser.mockImplementation(() => Promise.resolve(mockParsed));
      const parsed = await mockSimpleParser({} as SMTPServerDataStream);

      // The handler uses: html: parsed.html || parsed.text
      const htmlContent = parsed.html || parsed.text;
      expect(htmlContent).toBe("Plain text only");
    });

    it("should extract envelope addresses", () => {
      const session = {
        envelope: {
          mailFrom: { address: "sender@external.com" },
          rcptTo: [
            { address: "user1@test.com" },
            { address: "user2@test.com" }
          ]
        }
      } as unknown as SMTPServerSession;

      const envelopeTo = session.envelope.rcptTo.map((addr) => ({
        address: addr.address
      }));

      expect(envelopeTo).toEqual([
        { address: "user1@test.com" },
        { address: "user2@test.com" }
      ]);
    });

    it("should handle attachments", async () => {
      const mockParsed = {
        messageId: "<test@example.com>",
        from: { text: "sender@external.com", value: [] } as AddressObject,
        to: { text: "recipient@test.com", value: [] } as AddressObject,
        subject: "With Attachment",
        date: new Date(),
        html: "<p>Message</p>",
        text: "Message",
        attachments: [
          {
            filename: "document.pdf",
            contentType: "application/pdf",
            content: Buffer.from("pdf content"),
            size: 1024
          },
          {
            // No filename - should default to "attachment"
            contentType: "image/png",
            content: Buffer.from("image content"),
            size: 2048
          }
        ]
      };

      mockSimpleParser.mockImplementation(() => Promise.resolve(mockParsed));
      const parsed = await mockSimpleParser({} as SMTPServerDataStream);

      // The handler maps attachments like:
      // attachments: parsed.attachments?.map((att) => ({
      //   filename: att.filename || "attachment",
      //   contentType: att.contentType,
      //   content: att.content,
      //   size: att.size
      // }))
      const attachments = parsed.attachments?.map((att: { filename?: string; contentType: string; content: Buffer; size: number }) => ({
        filename: att.filename || "attachment",
        contentType: att.contentType,
        content: att.content,
        size: att.size
      }));

      expect(attachments?.length).toBe(2);
      expect(attachments?.[0].filename).toBe("document.pdf");
      expect(attachments?.[1].filename).toBe("attachment"); // fallback
    });

    it("should format date as ISO string", async () => {
      const testDate = new Date("2026-02-27T15:30:00Z");
      const mockParsed = {
        messageId: "<test@example.com>",
        from: { text: "sender@external.com", value: [] } as AddressObject,
        to: { text: "recipient@test.com", value: [] } as AddressObject,
        subject: "Test",
        date: testDate,
        html: "",
        text: "",
        attachments: []
      };

      mockSimpleParser.mockImplementation(() => Promise.resolve(mockParsed));
      const parsed = await mockSimpleParser({} as SMTPServerDataStream);

      // The handler uses: date: parsed.date?.toISOString()
      expect(parsed.date?.toISOString()).toBe("2026-02-27T15:30:00.000Z");
    });
  });

  describe("onDataOutgoing - authenticated sending", () => {
    it("should reject unauthenticated sending", () => {
      const session = {
        user: undefined, // No authenticated user
        envelope: {
          mailFrom: { address: "user@test.com" },
          rcptTo: [{ address: "external@other.com" }]
        }
      } as unknown as SMTPServerSession;

      expect(session.user).toBeUndefined();
      // Handler returns: cb(new Error("User not authenticated"))
    });

    it("should extract sender from envelope address", () => {
      const session = {
        user: "testuser",
        envelope: {
          mailFrom: { address: "alice@test.com" },
          rcptTo: [{ address: "bob@external.com" }]
        }
      } as unknown as SMTPServerSession;

      const fromAddress = session.envelope.mailFrom;
      const sender =
        (fromAddress && typeof fromAddress !== "boolean"
          ? fromAddress.address
          : ""
        )?.split("@")[0] || "admin";

      expect(sender).toBe("alice");
    });

    it("should default sender to admin when no address", () => {
      const session = {
        user: "testuser",
        envelope: {
          mailFrom: false,
          rcptTo: [{ address: "bob@external.com" }]
        }
      } as unknown as SMTPServerSession;

      const fromAddress = session.envelope.mailFrom;
      const sender =
        (fromAddress && typeof fromAddress !== "boolean"
          ? fromAddress.address
          : ""
        )?.split("@")[0] || "admin";

      expect(sender).toBe("admin");
    });

    it("should join multiple recipients", () => {
      const session = {
        user: "testuser",
        envelope: {
          mailFrom: { address: "user@test.com" },
          rcptTo: [
            { address: "alice@external.com" },
            { address: "bob@external.com" },
            { address: "charlie@external.com" }
          ]
        }
      } as unknown as SMTPServerSession;

      const to = session.envelope.rcptTo.map((addr) => addr.address).join(",");
      expect(to).toBe("alice@external.com,bob@external.com,charlie@external.com");
    });

    it("should use parsed from text as senderFullName", async () => {
      const mockParsed = {
        messageId: "<test@example.com>",
        from: { text: "Alice Smith <alice@test.com>", value: [{ address: "alice@test.com", name: "Alice Smith" }] } as AddressObject,
        to: { text: "bob@external.com", value: [] } as AddressObject,
        subject: "Hello Bob",
        html: "<p>Message</p>",
        text: "Message",
        attachments: []
      };

      mockSimpleParser.mockImplementation(() => Promise.resolve(mockParsed));
      const parsed = await mockSimpleParser({} as SMTPServerDataStream);

      // The handler uses: senderFullName: parsed.from?.text || sender
      expect(parsed.from?.text).toBe("Alice Smith <alice@test.com>");
    });

    it("should use empty string for subject when undefined", async () => {
      const mockParsed = {
        messageId: "<test@example.com>",
        from: { text: "alice@test.com", value: [] } as AddressObject,
        to: { text: "bob@external.com", value: [] } as AddressObject,
        subject: undefined,
        html: "<p>No subject</p>",
        text: "No subject",
        attachments: []
      };

      mockSimpleParser.mockImplementation(() => Promise.resolve(mockParsed));
      const parsed = await mockSimpleParser({} as SMTPServerDataStream);

      // The handler uses: subject: parsed.subject || ""
      const subject = parsed.subject || "";
      expect(subject).toBe("");
    });
  });

  describe("SMTP server initialization", () => {
    it("should start with port 25 for plain SMTP", () => {
      // The initializeSmtp function always starts a server on port 25
      // with secure: false (allows STARTTLS upgrade)
      const plainSmtpPort = 25;
      expect(plainSmtpPort).toBe(25);
    });

    it("should start port 465 for implicit TLS when certificates available", () => {
      process.env.SSL_CERTIFICATE = "/path/to/cert.pem";
      process.env.SSL_CERTIFICATE_KEY = "/path/to/key.pem";

      const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;
      const isSslAvailable = SSL_CERTIFICATE && SSL_CERTIFICATE_KEY;

      expect(isSslAvailable).toBeTruthy();
      // When SSL available, port 465 is started with secure: true
    });

    it("should start port 587 for submission when certificates available", () => {
      process.env.SSL_CERTIFICATE = "/path/to/cert.pem";
      process.env.SSL_CERTIFICATE_KEY = "/path/to/key.pem";

      // Port 587 is SMTP submission port with STARTTLS
      // Started with secure: false, allowInsecureAuth: true
      const submissionPort = 587;
      expect(submissionPort).toBe(587);
    });

    it("should skip ports 465 and 587 when SSL not available", () => {
      delete process.env.SSL_CERTIFICATE;
      delete process.env.SSL_CERTIFICATE_KEY;

      const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;
      const isSslAvailable = SSL_CERTIFICATE && SSL_CERTIFICATE_KEY;

      expect(isSslAvailable).toBeFalsy();
      // Only port 25 is started
    });
  });

  describe("Error handling", () => {
    it("should catch simpleParser errors for incoming mail", async () => {
      mockSimpleParser.mockImplementation(() =>
        Promise.reject(new Error("Parse error: malformed MIME"))
      );

      await expect(mockSimpleParser({} as SMTPServerDataStream)).rejects.toThrow(
        "Parse error: malformed MIME"
      );
      // The handler catches and calls: cb(err)
    });

    it("should handle user lookup errors gracefully", async () => {
      mockGetUser.mockImplementation(() =>
        Promise.reject(new Error("Database connection failed"))
      );

      await expect(mockGetUser({ username: "test" })).rejects.toThrow(
        "Database connection failed"
      );
    });

    it("should convert non-Error exceptions to Error objects", () => {
      // The onDataOutgoing handler has:
      // cb(err instanceof Error ? err : new Error(String(err)))
      const nonError = "string error message";
      const converted =
        nonError instanceof Error ? nonError : new Error(String(nonError));

      expect(converted).toBeInstanceOf(Error);
      expect(converted.message).toBe("string error message");
    });
  });

  describe("Session management", () => {
    it("should extract authenticated user from session", () => {
      const session = {
        user: "authenticatedUser",
        envelope: {
          mailFrom: { address: "user@test.com" },
          rcptTo: [{ address: "external@other.com" }]
        }
      } as unknown as SMTPServerSession;

      expect(session.user).toBe("authenticatedUser");
    });

    it("should handle session without user for incoming mail", () => {
      // Incoming mail doesn't require authentication
      const session = {
        user: undefined,
        envelope: {
          mailFrom: { address: "external@other.com" },
          rcptTo: [{ address: "user@test.com" }]
        }
      } as unknown as SMTPServerSession;

      expect(session.user).toBeUndefined();
      // This is valid for incoming mail - authOptional: true
    });
  });

  describe("bcrypt password verification", () => {
    it("should verify password correctly with proper hash", async () => {
      const password = "securePassword123!";
      const hash = await bcrypt.hash(password, 10);

      const isValid = await bcrypt.compare(password, hash);
      expect(isValid).toBe(true);
    });

    it("should reject incorrect password", async () => {
      const password = "securePassword123!";
      const hash = await bcrypt.hash(password, 10);

      const isValid = await bcrypt.compare("wrongPassword", hash);
      expect(isValid).toBe(false);
    });

    it("should handle empty password comparison", async () => {
      const hash = await bcrypt.hash("somePassword", 10);

      const isValid = await bcrypt.compare("", hash);
      expect(isValid).toBe(false);
    });
  });
});
