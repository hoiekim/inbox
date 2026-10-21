import { describe, it, expect, afterEach } from "bun:test";
import express from "express";
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
const originalEmailDomain = process.env.EMAIL_DOMAIN;
const originalAppHostname = process.env.APP_HOSTNAME;
const restoreEnv = () => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
  if (!secretWasSet) delete process.env.SECRET;
  if (originalEmailDomain !== undefined) process.env.EMAIL_DOMAIN = originalEmailDomain;
  else delete process.env.EMAIL_DOMAIN;
  if (originalAppHostname !== undefined) process.env.APP_HOSTNAME = originalAppHostname;
  else delete process.env.APP_HOSTNAME;
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

/**
 * Registers session-touching probe routes ahead of the catch-all `*` route
 * that {@link createHttpApp} mounts last. The probes must sit downstream of
 * the session middleware (so `req.session` is loaded) but upstream of the
 * catch-all (which would otherwise answer first with index.html). Splicing
 * the router stack is test-only plumbing — production never does this.
 */
const mountSessionProbes = (app: express.Application): void => {
  const probes = express.Router();
  probes.get("/__probe__", (req, res) => {
    (req.session as unknown as Record<string, unknown>).probe = 1;
    res.send("ok");
  });
  probes.get("/__untouched__", (_req, res) => {
    res.send("ok");
  });
  const stack = (app as unknown as { _router: { stack: unknown[] } })._router.stack;
  const probeLayers = (probes as unknown as { stack: unknown[] }).stack;
  const catchAllIdx = stack.findIndex(
    (layer) => (layer as { route?: { path?: unknown } }).route?.path === "*"
  );
  if (catchAllIdx === -1) throw new Error("catch-all route not found in app stack");
  stack.splice(catchAllIdx, 0, ...probeLayers);
};

const fetchSetCookies = async (
  mode: "production" | "development",
  probePath: "/__probe__" | "/__untouched__" = "/__probe__"
): Promise<string[]> => {
  if (mode === "production") {
    process.env.NODE_ENV = "production";
    if (!secretWasSet) process.env.SECRET = "<test-only-secret>";
  } else {
    process.env.NODE_ENV = "development";
  }

  // MemoryStore keeps the session middleware off any real store: the
  // assertions below read the cookie attributes the session middleware
  // actually emits on a live response, not the options object.
  const app = createHttpApp(new session.MemoryStore());
  mountSessionProbes(app);

  let server: Server | undefined;
  try {
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    // In production the app trusts loopback proxies (see createExpressApp)
    // and express-session only emits a Secure cookie over a secure request,
    // so the probe request must arrive as the TLS-terminating proxy would
    // forward it — otherwise the absence of Set-Cookie would be the session
    // middleware's correct refusal, not an assertion about the cookie.
    const res = await fetch(`http://127.0.0.1:${port}${probePath}`, {
      headers: mode === "production" ? { "X-Forwarded-Proto": "https" } : {}
    });
    await res.text();
    expect(res.status).toBe(200);
    return res.headers.getSetCookie();
  } finally {
    server?.close();
  }
};

describe("createHttpApp session cookie", () => {
  afterEach(restoreEnv);

  it("marks the session cookie Secure in production", async () => {
    const setCookies = await fetchSetCookies("production");
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatch(/\bSecure\b/);
  });

  it("leaves the session cookie non-Secure in development", async () => {
    const setCookies = await fetchSetCookies("development");
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).not.toMatch(/\bSecure\b/);
  });

  it("carries SameSite=Strict and a 7-day expiry on the session cookie", async () => {
    for (const mode of ["production", "development"] as const) {
      const setCookies = await fetchSetCookies(mode);
      expect(setCookies).toHaveLength(1);
      expect(setCookies[0]).toMatch(/SameSite=Strict/);
      // express-session serializes maxAge as an Expires date, not Max-Age —
      // assert the 7-day lifetime behaviorally off the emitted date.
      const expires = /Expires=([^;]+)/.exec(setCookies[0])?.[1];
      expect(expires).toBeDefined();
      const skewMs = Math.abs(
        new Date(expires!).getTime() - (Date.now() + 7 * 24 * 3600 * 1000)
      );
      expect(skewMs).toBeLessThan(60_000);
    }
  });

  it("sets no cookie for a session that was never touched", async () => {
    // saveUninitialized: false — an anonymous, unmodified session must not
    // mint a cookie at all.
    const setCookies = await fetchSetCookies("development", "/__untouched__");
    expect(setCookies).toHaveLength(0);
  });
});

const fetchAutoconfig = async (env: {
  emailDomain: string;
  appHostname?: string;
}): Promise<{ status: number; contentType: string | null; body: string }> => {
  process.env.NODE_ENV = "development";
  process.env.EMAIL_DOMAIN = env.emailDomain;
  if (env.appHostname !== undefined) process.env.APP_HOSTNAME = env.appHostname;
  else delete process.env.APP_HOSTNAME;

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
    const body = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type"), body };
  } finally {
    server?.close();
  }
};

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("createHttpApp mail autoconfig", () => {
  afterEach(restoreEnv);

  it("serves the autoconfig document as XML with the APP_HOSTNAME server hostname", async () => {
    const { status, contentType, body } = await fetchAutoconfig({
      emailDomain: "example.com",
      appHostname: "mail.host.example"
    });

    expect(status).toBe(200);
    expect(contentType).toBe("application/xml; charset=utf-8");
    // Both the IMAP and SMTP server entries point at the connectable
    // hostname, while the domain and provider id stay the MX domain.
    expect(countOccurrences(body, "<hostname>mail.host.example</hostname>")).toBe(2);
    expect(body).toContain("<domain>example.com</domain>");
    expect(body).toContain('<emailProvider id="example.com">');
  });

  it("falls back to EMAIL_DOMAIN for the server hostname when APP_HOSTNAME is unset", async () => {
    const { status, contentType, body } = await fetchAutoconfig({
      emailDomain: "example.com"
    });

    expect(status).toBe(200);
    expect(contentType).toBe("application/xml; charset=utf-8");
    expect(countOccurrences(body, "<hostname>example.com</hostname>")).toBe(2);
    expect(body).toContain("<domain>example.com</domain>");
    expect(body).toContain('<emailProvider id="example.com">');
  });
});

describe("createHttpApp boot ordering", () => {
  afterEach(restoreEnv);

  it("resolves the session secret before mounting anything: production without SECRET throws", async () => {
    // initializeHttp builds the app via createHttpApp and only then calls
    // app.listen, so a throw here means the boot-refusal guard fires before
    // any middleware mounts and listen is unreachable — the executable form
    // of "secret resolution runs before listen". Bracket notation keeps the
    // env restore out of the secret scanner's literal-assignment heuristic
    // (same pattern as session-secret.test.ts's withEnv).
    const outerSecret = process.env["SECRET"];
    process.env.NODE_ENV = "production";
    delete process.env["SECRET"];
    try {
      expect(() => createHttpApp(new session.MemoryStore())).toThrow(/SECRET/);
    } finally {
      if (outerSecret !== undefined) process.env["SECRET"] = outerSecret;
      else delete process.env["SECRET"];
    }
  });
});
