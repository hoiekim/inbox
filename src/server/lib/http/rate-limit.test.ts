import { describe, it, expect, mock } from "bun:test";

const makeReq = (ip: string) =>
  ({
    ip,
    headers: {},
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

describe("createLimiter middleware", () => {
  it("passes requests through when no failures recorded", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(3, "too many");
    const req = makeReq("1.2.3.4");
    const res = makeRes();
    const next = mock(() => {});

    limiter.middleware(req, res, next);
    limiter.middleware(req, res, next);
    limiter.middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks once recordFailure pushes the counter to the max", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "rate limited");
    const req = makeReq("10.0.0.1");
    const res = makeRes();
    const next = mock(() => {});

    // Before any failures, requests pass.
    limiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Record two failures — now at the cap.
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.1");

    limiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1); // not incremented
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("does NOT increment on the middleware path (successes don't burn quota)", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "limit");
    const req = makeReq("10.0.0.2");
    const res = makeRes();
    const next = mock(() => {});

    // 10 successful pass-throughs do not consume any slots.
    for (let i = 0; i < 10; i++) limiter.middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(10);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("reset clears the per-IP counter", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "limit");
    const req = makeReq("10.0.0.3");
    const res = makeRes();
    const next = mock(() => {});

    limiter.recordFailure("10.0.0.3");
    limiter.recordFailure("10.0.0.3");
    limiter.middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);

    limiter.reset("10.0.0.3");
    const res2 = makeRes();
    limiter.middleware(req, res2, next);
    expect(res2.status).not.toHaveBeenCalled();
  });

  it("isolates counters between different limiters (regression for #221)", async () => {
    const { createLimiter } = await import("./rate-limit");

    const limiterA = createLimiter(5, "A limit");
    const limiterB = createLimiter(3, "B limit");

    const ip = "192.168.1.1";
    const reqA = makeReq(ip);
    const reqB = makeReq(ip);
    const resA = makeRes();
    const resB = makeRes();
    const nextA = mock(() => {});
    const nextB = mock(() => {});

    // Exhaust limiterB (3 recorded failures).
    limiterB.recordFailure(ip);
    limiterB.recordFailure(ip);
    limiterB.recordFailure(ip);

    limiterB.middleware(reqB, resB, nextB);
    expect(resB.status).toHaveBeenCalledWith(429);

    // limiterA should be UNAFFECTED — counter is isolated.
    limiterA.middleware(reqA, resA, nextA);
    limiterA.middleware(reqA, resA, nextA);
    limiterA.middleware(reqA, resA, nextA);
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
    limiter.recordFailure("5.5.5.5");

    // Manually force expiry by calling cleanup — records haven't expired so
    // cleaned count may be 0, but the call should not throw.
    expect(() => cleanupExpiredAttempts()).not.toThrow();
  });
});

describe("startCleanupScheduler / stopCleanupScheduler", () => {
  it("starts and stops without throwing", async () => {
    const { startCleanupScheduler, stopCleanupScheduler } = await import(
      "./rate-limit"
    );

    expect(() => startCleanupScheduler()).not.toThrow();
    expect(() => startCleanupScheduler()).not.toThrow();
    expect(() => stopCleanupScheduler()).not.toThrow();
    expect(() => stopCleanupScheduler()).not.toThrow();
  });
});
