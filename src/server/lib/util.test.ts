import { describe, it, expect, afterEach } from "bun:test";
import { getDomain, getUserDomain } from "./util";

describe("getDomain", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("returns EMAIL_DOMAIN env var when set", () => {
    process.env.EMAIL_DOMAIN = "example.com";
    expect(getDomain()).toBe("example.com");
  });

  it("returns 'mydomain' as default when EMAIL_DOMAIN is unset", () => {
    delete process.env.EMAIL_DOMAIN;
    expect(getDomain()).toBe("mydomain");
  });
});

describe("getUserDomain", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("returns base domain for admin user", () => {
    process.env.EMAIL_DOMAIN = "example.com";
    expect(getUserDomain("admin")).toBe("example.com");
  });

  it("returns subdomain for regular user", () => {
    process.env.EMAIL_DOMAIN = "example.com";
    expect(getUserDomain("alice")).toBe("alice.example.com");
  });

  it("uses default domain when EMAIL_DOMAIN is unset", () => {
    delete process.env.EMAIL_DOMAIN;
    expect(getUserDomain("bob")).toBe("bob.mydomain");
  });
});
