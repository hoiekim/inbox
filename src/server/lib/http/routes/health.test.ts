import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ── Mock net, tls, fs, and postgres BEFORE importing health router ───────────

const makeSocketMock = () => {
  const socket: Record<string, unknown> = {};
  const handlers: Record<string, () => void> = {};
  socket.destroy = mock(() => {});
  socket.end = mock((cb?: () => void) => { if (cb) cb(); return socket; });
  socket.setTimeout = mock(() => socket);
  socket.on = mock((event: string, cb: () => void) => {
    handlers[event] = cb;
    return socket;
  });
  (socket as { _handlers: Record<string, () => void> })._handlers = handlers;
  return socket;
};

let netSocketMock = makeSocketMock();
let tlsSocketMock = makeSocketMock();

// Controls what happens when a TCP connection is attempted:
// "connect" = call the connect callback (success)
// "error"   = fire the error event handler
// "timeout" = fire the timeout event handler
let netBehavior: "connect" | "error" | "timeout" = "connect";
let tlsBehavior: "connect" | "error" | "timeout" = "connect";

const mockCreateConnection = mock((_opts: unknown, cb: () => void) => {
  const socket = makeSocketMock();
  netSocketMock = socket;
  setTimeout(() => {
    if (netBehavior === "connect") cb();
    else if (netBehavior === "error") (socket as { _handlers: Record<string, () => void> })._handlers["error"]?.();
    else if (netBehavior === "timeout") (socket as { _handlers: Record<string, () => void> })._handlers["timeout"]?.();
  }, 0);
  return socket;
});

const mockTlsConnect = mock((_opts: unknown, cb: () => void) => {
  const socket = makeSocketMock();
  tlsSocketMock = socket;
  setTimeout(() => {
    if (tlsBehavior === "connect") cb();
    else if (tlsBehavior === "error") (socket as { _handlers: Record<string, () => void> })._handlers["error"]?.();
    else if (tlsBehavior === "timeout") (socket as { _handlers: Record<string, () => void> })._handlers["timeout"]?.();
  }, 0);
  return socket;
});

mock.module("net", () => ({ createConnection: mockCreateConnection }));
mock.module("tls", () => ({ connect: mockTlsConnect }));

// fs.existsSync is consulted by isSslConfigured(). When the test sets
// SSL_CERTIFICATE/_KEY env vars, the mock returns true so the SSL gate opens.
let existsSyncResult = true;
mock.module("fs", () => ({ existsSync: () => existsSyncResult }));

const mockPoolQuery = mock(async () => [{ "?column?": 1 }]);
mock.module("../../postgres/client", () => ({ pool: { query: mockPoolQuery } }));

// ── Helper to call the health router GET "/" directly ─────────────────────────

import type { Request, Response, NextFunction } from "express";
import { Router } from "express";

const makeRes = () => {
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  return res as unknown as Response & { _code: number; _body: unknown };
};

const makeReq = () => ({
  method: "GET",
  path: "/",
} as unknown as Request);

/** Invoke the first matching GET "/" layer in the health router. */
const invokeHealthGet = async (router: Router): Promise<Response & { _code: number; _body: unknown }> => {
  const res = makeRes();
  const req = makeReq();
  const next = mock(() => {});

  // Find all layers with route path "/"
  const layers = (router as unknown as { stack: unknown[] }).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => void }> };
  }>;

  for (const layer of layers) {
    if (layer.route?.path === "/" && layer.route.methods["get"]) {
      for (const handler of layer.route.stack) {
        await handler.handle(req, res, next);
      }
      break;
    }
  }

  return res;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = {
  SSL_CERTIFICATE: process.env.SSL_CERTIFICATE,
  SSL_CERTIFICATE_KEY: process.env.SSL_CERTIFICATE_KEY,
  SMTP_PORT: process.env.SMTP_PORT,
  IMAP_PORT: process.env.IMAP_PORT,
};

const restoreEnv = () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe("healthRouter GET /", () => {
  beforeEach(() => {
    mockPoolQuery.mockClear();
    mockCreateConnection.mockClear();
    mockTlsConnect.mockClear();
    netBehavior = "connect";
    tlsBehavior = "connect";
    existsSyncResult = true;
    // Default: SSL configured so existing assertions about TLS ports apply.
    process.env.SSL_CERTIFICATE = "/fake/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/fake/key.pem";
    delete process.env.IMAP_PORT;
    delete process.env.SMTP_PORT;
  });

  afterAll(() => {
    restoreEnv();
  });

  it("returns 200 with status:'success' when everything is healthy (SSL configured)", async () => {
    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.status).toBe("success");
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks.database).toBe("ok");
    expect(body.body.checks.http).toBe("ok");
    expect(body.body.checks["smtp:465"]).toBe("ok");
    expect(body.body.checks["imap:993"]).toBe("ok");
  });

  it("returns 503 when DB is unhealthy", async () => {
    mockPoolQuery.mockImplementationOnce(async () => { throw new Error("DB down"); });

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.status).toBe("error");
    expect(body.body.healthy).toBe(false);
    expect(body.body.checks.database).toBe("unhealthy");
  });

  it("returns 503 when a TCP port fails (error event)", async () => {
    netBehavior = "error";

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(false);
  });

  it("returns 503 when a TLS port fails (SSL configured)", async () => {
    tlsBehavior = "error";

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
  });

  it("always marks HTTP check as ok", async () => {
    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.checks.http).toBe("ok");
  });

  it("includes a numeric timestamp", async () => {
    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(typeof body.body.timestamp).toBe("number");
    expect(body.body.timestamp).toBeGreaterThan(0);
  });

  // ── New: TLS-not-configured behavior (#466) ─────────────────────────────────

  it("returns 200 and marks TLS ports 'not_configured' when SSL_CERTIFICATE is unset", async () => {
    delete process.env.SSL_CERTIFICATE;
    delete process.env.SSL_CERTIFICATE_KEY;

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks["smtp:465"]).toBe("not_configured");
    expect(body.body.checks["smtp:587"]).toBe("not_configured");
    expect(body.body.checks["imap:993"]).toBe("not_configured");
    // Plain ports remain required
    expect(body.body.checks["smtp:25"]).toBe("ok");
    expect(body.body.checks["imap:143"]).toBe("ok");
    // TLS probe never invoked when SSL not configured
    expect(mockTlsConnect).not.toHaveBeenCalled();
  });

  it("returns 200 and marks TLS ports 'not_configured' when cert files are missing", async () => {
    process.env.SSL_CERTIFICATE = "/fake/cert.pem";
    process.env.SSL_CERTIFICATE_KEY = "/fake/key.pem";
    existsSyncResult = false;

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks["imap:993"]).toBe("not_configured");
    expect(mockTlsConnect).not.toHaveBeenCalled();
  });

  it("returns 503 when SSL configured but TLS port fails (regression)", async () => {
    tlsBehavior = "error";

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.healthy).toBe(false);
    expect(body.body.checks["imap:993"]).toBe("unhealthy");
  });

  it("uses IMAP_PORT env when set", async () => {
    process.env.IMAP_PORT = "21001";

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    const body = res._body as { status: string; body: { healthy: boolean; checks: Record<string, string>; timestamp: number } };
    expect(body.body.checks["imap:21001"]).toBe("ok");
    expect(body.body.checks["imap:143"]).toBeUndefined();
  });
});
