import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mock net, tls, and postgres BEFORE importing health router ───────────────

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

describe("healthRouter GET /", () => {
  beforeEach(() => {
    mockPoolQuery.mockClear();
    mockCreateConnection.mockClear();
    mockTlsConnect.mockClear();
    netBehavior = "connect";
    tlsBehavior = "connect";
  });

  it("returns 200 with status:'success' when everything is healthy", async () => {
    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(200);
    const body = res._body as { status: string; body: { healthy: boolean; checks: { database: string; http: string }; timestamp: number } };
    expect(body.status).toBe("success");
    expect(body.body.healthy).toBe(true);
    expect(body.body.checks.database).toBe("ok");
    expect(body.body.checks.http).toBe("ok");
  });

  it("returns 503 when DB is unhealthy", async () => {
    mockPoolQuery.mockImplementationOnce(async () => { throw new Error("DB down"); });

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: { database: string; http: string }; timestamp: number } };
    expect(body.status).toBe("error");
    expect(body.body.healthy).toBe(false);
    expect(body.body.checks.database).toBe("unhealthy");
  });

  it("returns 503 when a TCP port fails (error event)", async () => {
    netBehavior = "error";

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
    const body = res._body as { status: string; body: { healthy: boolean; checks: { database: string; http: string }; timestamp: number } };
    expect(body.body.healthy).toBe(false);
  });

  it("returns 503 when a TLS port fails", async () => {
    tlsBehavior = "error";

    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    expect(res._code).toBe(503);
  });

  it("always marks HTTP check as ok", async () => {
    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    const body = res._body as { status: string; body: { healthy: boolean; checks: { database: string; http: string }; timestamp: number } };
    expect(body.body.checks.http).toBe("ok");
  });

  it("includes a numeric timestamp", async () => {
    const { default: healthRouter } = await import("./health");
    const res = await invokeHealthGet(healthRouter);

    const body = res._body as { status: string; body: { healthy: boolean; checks: { database: string; http: string }; timestamp: number } };
    expect(typeof body.body.timestamp).toBe("number");
    expect(body.body.timestamp).toBeGreaterThan(0);
  });
});
