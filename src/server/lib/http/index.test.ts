import { describe, it, expect, afterEach } from "bun:test";
import session from "express-session";
import type { Server } from "http";

import { createHttpApp } from "./index";

/**
 * The security headers are registered by exactly one middleware in
 * {@link createHttpApp}. A second registration re-setting the same values
 * would be silently shadowed by registration order — this assertion pins the
 * exact security-header set on a representative response, so a future
 * duplicate (or a divergent value, or a re-added X-XSS-Protection) fails
 * loudly here instead of hiding in the ordering.
 */
const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

const SECURITY_HEADER_NAMES = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "strict-transport-security",
  "x-xss-protection"
] as const;

const originalNodeEnv = process.env.NODE_ENV;
// When the outer environment already provides SECRET it is left untouched;
// the placeholder below is only installed when production boot would
// otherwise refuse, and removed afterwards.
const secretWasSet = process.env.SECRET !== undefined;
const restoreEnv = () => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
  if (!secretWasSet) delete process.env.SECRET;
};

const fetchSecurityHeaders = async (
  mode: "production" | "development"
): Promise<{ status: number; headers: Record<string, string> }> => {
  if (mode === "production") {
    process.env.NODE_ENV = "production";
    if (!secretWasSet) process.env.SECRET = "<test-only-secret>";
  } else {
    process.env.NODE_ENV = "development";
  }

  // MemoryStore keeps the session middleware off any real store: the security
  // header middleware runs upstream of it and applies to every response.
  const app = createHttpApp(new session.MemoryStore());

  let server: Server | undefined;
  try {
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/autoconfig/mail/config-v1.1.xml`
    );
    await res.text();
    const headers: Record<string, string> = {};
    for (const [name, value] of res.headers.entries()) {
      headers[name] = value;
    }
    return { status: res.status, headers };
  } finally {
    server?.close();
  }
};

const securityHeadersOf = (
  headers: Record<string, string>
): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    if (headers[name] !== undefined) picked[name] = headers[name]!;
  }
  return picked;
};

describe("createHttpApp security headers", () => {
  afterEach(restoreEnv);

  it("emits exactly the expected security-header set in development", async () => {
    const { status, headers } = await fetchSecurityHeaders("development");

    expect(status).toBe(200);
    expect(securityHeadersOf(headers)).toEqual({
      "content-security-policy": EXPECTED_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin"
      // Strict-Transport-Security is production-only; X-XSS-Protection is
      // intentionally absent — both omissions are part of the assertion.
    });
  });

  it("adds the production-gated HSTS without re-adding X-XSS-Protection", async () => {
    const { status, headers } = await fetchSecurityHeaders("production");

    expect(status).toBe(200);
    expect(securityHeadersOf(headers)).toEqual({
      "content-security-policy": EXPECTED_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "strict-transport-security": "max-age=31536000; includeSubDomains"
    });
    expect(headers["x-xss-protection"]).toBeUndefined();
  });
});
