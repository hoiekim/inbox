import { describe, it, expect } from "bun:test";
import type { HttpRequest } from "./request";

const makeReq = (ip: string) =>
  ({
    ip,
    headers: new Headers(),
  }) as unknown as HttpRequest;

describe("createLimiter check", () => {
  it("passes requests through when no failures recorded", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(3, "too many");
    const req = makeReq("1.2.3.4");

    expect([limiter.check(req), limiter.check(req), limiter.check(req)]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("blocks once recordFailure pushes the counter to the max", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "rate limited");
    const req = makeReq("10.0.0.1");

    // Before any failures, requests pass.
    expect(limiter.check(req)).toBeUndefined();

    // Record two failures — now at the cap.
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.1");

    const refused = limiter.check(req);
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toEqual({ status: "failed", message: "rate limited" });
  });

  it("does NOT increment on the check path (successes don't burn quota)", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "limit");
    const req = makeReq("10.0.0.2");

    // 10 successful pass-throughs do not consume any slots.
    const refusals = Array.from({ length: 10 }, () => limiter.check(req)).filter(Boolean);
    expect(refusals).toEqual([]);
  });

  it("reset clears the per-IP counter", async () => {
    const { createLimiter } = await import("./rate-limit");
    const limiter = createLimiter(2, "limit");
    const req = makeReq("10.0.0.3");

    limiter.recordFailure("10.0.0.3");
    limiter.recordFailure("10.0.0.3");
    expect(limiter.check(req)?.status).toBe(429);

    limiter.reset("10.0.0.3");
    expect(limiter.check(req)).toBeUndefined();
  });

  it("isolates counters between different limiters (regression for #221)", async () => {
    const { createLimiter } = await import("./rate-limit");

    const limiterA = createLimiter(5, "A limit");
    const limiterB = createLimiter(3, "B limit");

    const ip = "192.168.1.1";
    const req = makeReq(ip);

    // Exhaust limiterB (3 recorded failures).
    limiterB.recordFailure(ip);
    limiterB.recordFailure(ip);
    limiterB.recordFailure(ip);

    expect(limiterB.check(req)?.status).toBe(429);

    // limiterA should be UNAFFECTED — counter is isolated.
    expect([limiterA.check(req), limiterA.check(req), limiterA.check(req)]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
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

describe("getClientIp", () => {
  // The defect this replaces: the forwarding headers were read first, so the
  // caller named its own bucket. Both headers are set to values that disagree
  // with req.ip, so a function that consults either one fails here.
  it("reads req.ip and ignores forwarding headers that disagree with it", async () => {
    const { getClientIp } = await import("./rate-limit");
    const req = {
      ip: "203.0.113.9",
      headers: new Headers({
        "x-real-ip": "9.9.9.9",
        "x-forwarded-for": "9.9.9.8, 9.9.9.7"
      })
    } as unknown as HttpRequest;

    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to a constant when no address was resolved", async () => {
    const { getClientIp } = await import("./rate-limit");
    const req = {
      ip: "",
      headers: new Headers({ "x-real-ip": "9.9.9.9" })
    } as unknown as HttpRequest;

    expect(getClientIp(req)).toBe("unknown");
  });

  // Asserts the mapped values rather than a predicate over them: eight distinct
  // header values must all collapse onto the single req.ip bucket, so a
  // rotating caller cannot buy itself a fresh quota.
  it("maps every rotated header value onto the same bucket", async () => {
    const { getClientIp } = await import("./rate-limit");
    const buckets = Array.from({ length: 8 }, (_, i) =>
      getClientIp({
        ip: "203.0.113.9",
        headers: new Headers({
          "x-real-ip": `198.51.100.${i + 1}`,
          "x-forwarded-for": `198.51.100.${i + 1}`
        })
      } as unknown as HttpRequest)
    );

    expect(buckets).toEqual(Array.from({ length: 8 }, () => "203.0.113.9"));
  });
});

// Driven through the assembled production pipeline, because the property
// under test is how a request's address is resolved from its peer and its
// forwarding headers — asserting the trust list alone would not show what a
// request actually gets bucketed as. The client-error route stands in for any
// rate-limited route: it counts every request against a cap of five per IP.
describe("rate-limit bucket through the app, production trust-proxy posture", () => {
  const CAP = 5;

  const startProbe = async (peer: string) => {
    const previous = { nodeEnv: process.env.NODE_ENV, secret: process.env.SECRET };
    process.env.NODE_ENV = "production";
    if (!previous.secret) process.env.SECRET = "<test-only-secret>";
    let app: import("./index").HttpApp;
    try {
      const { createHttpApp } = await import("./index");
      app = createHttpApp({ get: async () => null, set: async () => {}, destroy: async () => {} });
    } finally {
      // A throw before the restore would leave the variable at "production" for
      // the rest of the process, where resolveSessionSecret throws rather than
      // warning — turning one failure into a cascade that points away from it.
      if (previous.nodeEnv !== undefined) process.env.NODE_ENV = previous.nodeEnv;
      else delete process.env.NODE_ENV;
      if (previous.secret === undefined) delete process.env.SECRET;
    }

    return {
      post: async (headers: Record<string, string>) => {
        const res = await app(
          new Request("http://localhost/api/client-error", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ message: "probe" }),
          }),
          peer
        );
        await res.text();
        return res.status;
      },
    };
  };

  it("keeps a peer outside the trusted range in one bucket however it rotates the headers", async () => {
    const probe = await startProbe("198.51.100.66");
    const statuses: number[] = [];
    for (let i = 1; i <= CAP + 2; i++) {
      statuses.push(
        await probe.post({
          "x-real-ip": `203.0.113.${i}`,
          "x-forwarded-for": `203.0.113.${i}`
        })
      );
    }

    // Five allowed, then the cap holds — every request landed in the peer's
    // own address, not in the one it asked for.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  // The other half: behind the proxy the forwarded address must still be what
  // separates one client from another, or a single cap would cover everyone.
  it("gives each forwarded client its own bucket when the peer is the proxy", async () => {
    const probe = await startProbe("172.20.0.2");
    const first: number[] = [];
    for (let i = 1; i <= CAP + 1; i++) {
      first.push(await probe.post({ "x-forwarded-for": "203.0.113.30" }));
    }
    const other = await probe.post({ "x-forwarded-for": "203.0.113.31" });

    expect(first).toEqual([200, 200, 200, 200, 200, 429]);
    expect(other).toBe(200);
  });
});

// Regression tests for #1032: a successful login used to delete the IP's
// entire failure bucket, so one self-registered account turned the 5-per-15-min
// cap into unlimited guesses at any other user. Failures are now tracked per
// (ip, account) under a per-IP aggregate ceiling; success forgives only the
// authenticating account's own bucket.
describe("account-scoped login buckets", () => {
  const CAP = 5;

  const makeLoginLimiter = async () => {
    const { createLimiter, loginIdentityOf } = await import("./rate-limit");
    return createLimiter(CAP, "too many", { identityOf: loginIdentityOf });
  };

  const loginReq = (ip: string, username: string) =>
    ({
      ip,
      body: { username, password: "x" },
      headers: new Headers()
    }) as unknown as HttpRequest;

  it("a success as another account does not forgive the victim's failures", async () => {
    const limiter = await makeLoginLimiter();
    const ip = "203.0.113.21";

    // Four failed guesses as the victim.
    for (let i = 0; i < 4; i++) limiter.recordFailure(ip, "victim");
    // One successful login as the attacker's own account — clears only the
    // attacker's own bucket.
    limiter.reset(ip, "attacker");
    // The fifth failed guess as the victim is recorded...
    limiter.recordFailure(ip, "victim");

    expect(limiter.check(loginReq(ip, "victim"))?.status).toBe(429);
  });

  it("rotating the username trips the per-IP ceiling", async () => {
    const limiter = await makeLoginLimiter();
    const ip = "203.0.113.22";

    // One failure each under five distinct identities: no single account
    // bucket is near the cap, but the IP aggregate has five failures.
    for (let i = 1; i <= 5; i++) limiter.recordFailure(ip, `target${i}`);

    // A sixth attempt under yet another fresh identity is still refused.
    expect(limiter.check(loginReq(ip, "target6"))?.status).toBe(429);
  });

  it("a user's own successful login clears their own failures", async () => {
    const limiter = await makeLoginLimiter();
    const ip = "203.0.113.23";

    // Four failures as alice, then she logs in successfully.
    for (let i = 0; i < 4; i++) limiter.recordFailure(ip, "alice");
    limiter.reset(ip, "alice");

    // No lingering penalty: her next attempt passes the check even though
    // the per-IP aggregate still holds her four failures.
    expect(limiter.check(loginReq(ip, "alice"))).toBeUndefined();
  });

  it("a whole-IP reset still clears every bucket under the IP", async () => {
    const limiter = await makeLoginLimiter();
    const ip = "203.0.113.24";

    limiter.recordFailure(ip, "alice");
    limiter.recordFailure(ip, "alice");
    limiter.reset(ip);

    expect(limiter.check(loginReq(ip, "alice"))).toBeUndefined();
  });
});
