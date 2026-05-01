import { describe, it, expect, mock } from "bun:test";

mock.module("../../logger", () => ({
  logger: { error: mock(() => {}), info: mock(() => {}), warn: mock(() => {}) },
}));
mock.module("../../alarm", () => ({
  sendAlarm: mock(async () => {}),
}));

import { Route, StreamingStatus, authRequired, AUTH_ERROR_MESSAGE } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    session: {},
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as import("express").Request;

const makeRes = () => {
  const chunks: string[] = [];
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  res.send = mock((body: unknown) => { res._body = body; return res; });
  res.write = mock((chunk: string) => { chunks.push(chunk); return true; });
  res.end = mock(() => res);
  (res as unknown as { _chunks: string[] })._chunks = chunks;
  return res as unknown as import("express").Response & { _code: number; _body: unknown; _chunks: string[] };
};

const makeNext = () => mock(() => {});

// ── StreamingStatus ───────────────────────────────────────────────────────────

describe("StreamingStatus", () => {
  it("returns 'streaming' while under limit", () => {
    const s = new StreamingStatus(3);
    expect(s.get()).toBe("streaming");
    expect(s.get()).toBe("streaming");
  });

  it("returns 'success' when limit is reached", () => {
    const s = new StreamingStatus(2);
    s.get(); // 1
    expect(s.get()).toBe("success"); // 2 == limit
  });

  it("defaults limit to 1 → first call returns 'success'", () => {
    const s = new StreamingStatus();
    expect(s.get()).toBe("success");
  });
});

// ── Route.handler ─────────────────────────────────────────────────────────────

describe("Route.handler", () => {
  it("calls next() when method does not match", async () => {
    const cb = mock(async () => ({ status: "success" as const }));
    const route = new Route("POST", "/test", cb);

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect(cb).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("responds with json result when method matches", async () => {
    const route = new Route("GET", "/test", async () => ({ status: "success" as const, body: { hello: "world" } }));

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ status: "success", body: { hello: "world" } });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls res.end() when callback returns nothing (void)", async () => {
    const route = new Route("POST", "/test", async () => undefined);

    const req = makeReq({ method: "POST" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect(res.end).toHaveBeenCalled();
  });

  it("sends Buffer directly with res.send()", async () => {
    const buf = Buffer.from("binary data");
    const route = new Route("GET", "/bin", async () => buf);

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it("writes streamed JSON chunks via stream callback", async () => {
    const route = new Route("GET", "/stream", async (_req, _res, stream) => {
      stream({ status: "streaming", body: "chunk-1" });
      stream({ status: "success", body: "chunk-2" });
    });

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect((res as unknown as { _chunks: string[] })._chunks.length).toBe(2);
    expect((res as unknown as { _chunks: string[] })._chunks[0]).toContain("chunk-1");
  });

  it("writes Buffer chunks directly via stream callback", async () => {
    const buf = Buffer.from("raw");
    const route = new Route<Buffer>("GET", "/bufstream", async (_req, _res, stream) => {
      stream(buf);
    });

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect(res.write).toHaveBeenCalledWith(buf);
  });

  it("returns 500 json on thrown error", async () => {
    process.env.NODE_ENV = "test"; // non-production
    const route = new Route("GET", "/boom", async () => {
      throw new Error("kaboom");
    });

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as unknown as { _body: unknown })._body).toMatchObject({ status: "error", message: "kaboom" });
  });

  it("hides error message in production", async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const route = new Route("GET", "/boom-prod", async () => {
      throw new Error("secret details");
    });

    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = makeNext();

    await route.handler(req, res, next);

    expect((res as unknown as { _body: unknown })._body).toMatchObject({ status: "error", message: "Internal server error" });
    process.env.NODE_ENV = origEnv;
  });
});

// ── authRequired ──────────────────────────────────────────────────────────────

describe("authRequired", () => {
  it("calls next() when session.user is set", () => {
    const req = makeReq({ session: { user: { id: "u1", username: "alice" } } });
    const res = makeRes();
    const next = makeNext();

    authRequired(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when session.user is absent", () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    const next = makeNext();

    authRequired(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect((res as unknown as { _body: unknown })._body).toMatchObject({ status: "failed", message: AUTH_ERROR_MESSAGE });
    expect(next).not.toHaveBeenCalled();
  });
});
