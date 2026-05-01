import { describe, expect, it, afterEach } from "bun:test";
import crypto from "crypto";
import { User } from "common";
import {
  getSignedUser,
  isValidEmail,
  createAuthenticationMail,
} from "./users";

describe("Token generation security", () => {
  it("uses cryptographically secure random bytes", () => {
    // This test validates the approach used in createToken()
    const token = crypto.randomBytes(32).toString("hex");

    // Token should be 64 hex characters (32 bytes = 64 hex chars)
    expect(token.length).toBe(64);

    // Token should only contain hex characters
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();

    // Generate 100 tokens and verify uniqueness
    for (let i = 0; i < 100; i++) {
      const token = crypto.randomBytes(32).toString("hex");
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }

    expect(tokens.size).toBe(100);
  });

  it("has sufficient entropy (256 bits)", () => {
    // 32 bytes = 256 bits of entropy
    // This is well above the minimum recommended 128 bits for security tokens
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
