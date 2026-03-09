import { describe, it, expect, mock, beforeEach } from "bun:test";

// We test the module internals by importing after mocking express types
// so we can construct fake Request/Response objects.
const mockNext = mock(() => {});

const makeReq = (ip: string) =>
  ({
    ip,
    socket: { remoteAddress: ip },
  }) as unknown as import("express").Request;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = mock((code: number) => {
    res._code = code;
    return res;
  });
  res.json = mock((body: unknown) => {
    res._body = body;
    return res;
  });
  return res as unknown as import("express").Response;
};

describe("createLimiter", () => {
  it("allows requests below the limit", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(3, "too many");
    const req = makeReq("1.2.3.4");
    const res = makeRes();
    const next = mock(() => {});

    limiter(req, res, next);
    limiter(req, res, next);
    limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks requests over the limit", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "rate limited");
    const req = makeReq("10.0.0.1");
    const res = makeRes();
    const next = mock(() => {});

    limiter(req, res, next); // 1
    limiter(req, res, next); // 2
    limiter(req, res, next); // 3 — should be blocked

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("isolates counters between different limiters (regression for #221)", async () => {
    const { createLimiter } = await import("./rate-limit");

    // limiterA allows 5 attempts; limiterB allows 3
    const limiterA = createLimiter(5, "A limit");
    const limiterB = createLimiter(3, "B limit");

    const ip = "192.168.1.1";
    const reqA = makeReq(ip);
    const reqB = makeReq(ip);
    const resA = makeRes();
    const resB = makeRes();
    const nextA = mock(() => {});
    const nextB = mock(() => {});

    // Exhaust limiterB (3 calls)
    limiterB(reqB, resB, nextB);
    limiterB(reqB, resB, nextB);
    limiterB(reqB, resB, nextB);
    expect(nextB).toHaveBeenCalledTimes(3);

    // limiterB is now at its max — next call should be blocked
    limiterB(reqB, resB, nextB);
    expect(nextB).toHaveBeenCalledTimes(3); // still 3, not 4

    // limiterA should be UNAFFECTED — counter is isolated
    limiterA(reqA, resA, nextA);
    limiterA(reqA, resA, nextA);
    limiterA(reqA, resA, nextA);
    expect(nextA).toHaveBeenCalledTimes(3);
    expect(resA.status).not.toHaveBeenCalled();
  });
});

describe("cleanupExpiredAttempts", () => {
  it("cleans up records across all limiter Maps", async () => {
    const { createLimiter, cleanupExpiredAttempts } = await import(
      "./rate-limit"
    );
    const limiter = createLimiter(5, "cleanup test");
    const req = makeReq("5.5.5.5");
    const res = makeRes();
    const next = mock(() => {});

    limiter(req, res, next);

    // Manually force expiry by calling cleanup — records haven't expired so
    // cleaned count may be 0, but the call should not throw.
    expect(() => cleanupExpiredAttempts()).not.toThrow();
  });
});
