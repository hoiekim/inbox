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

describe("getClientIp", () => {
  // The defect this replaces: the forwarding headers were read first, so the
  // caller named its own bucket. Both headers are set to values that disagree
  // with req.ip, so a function that consults either one fails here.
  it("reads req.ip and ignores forwarding headers that disagree with it", async () => {
    const { getClientIp } = await import("./rate-limit");
    const req = {
      ip: "203.0.113.9",
      headers: {
        "x-real-ip": "9.9.9.9",
        "x-forwarded-for": "9.9.9.8, 9.9.9.7"
      },
      socket: { remoteAddress: "203.0.113.9" }
    } as unknown as import("express").Request;

    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to a constant when express resolved no address", async () => {
    const { getClientIp } = await import("./rate-limit");
    const req = {
      ip: undefined,
      headers: { "x-real-ip": "9.9.9.9" },
      socket: {}
    } as unknown as import("express").Request;

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
        headers: {
          "x-real-ip": `198.51.100.${i + 1}`,
          "x-forwarded-for": `198.51.100.${i + 1}`
        },
        socket: { remoteAddress: "203.0.113.9" }
      } as unknown as import("express").Request)
    );

    expect(buckets).toEqual(Array.from({ length: 8 }, () => "203.0.113.9"));
  });
});

// Driven over real HTTP against the production app factory, because the
// property under test is express's own resolution of req.ip from the
// `trust proxy` setting — asserting the setting's value alone would not show
// what a request actually gets bucketed as. The front middleware rewrites the
// peer address on the live socket, which is the only way to present a peer
// outside the loopback range without a public interface to bind.
describe("rate-limit bucket over HTTP, production trust-proxy posture", () => {
  const CAP = 3;

  const startProbe = async (peer: string) => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let app: import("express").Application;
    let createLimiter: typeof import("./rate-limit").createLimiter;
    let getClientIp: typeof import("./rate-limit").getClientIp;
    try {
      const appModule = await import("./app");
      const rateLimitModule = await import("./rate-limit");
      createLimiter = rateLimitModule.createLimiter;
      getClientIp = rateLimitModule.getClientIp;
      app = appModule.createExpressApp();
    } finally {
      // A throw before the restore would leave the variable at "production" for
      // the rest of the process, where resolveSessionSecret throws rather than
      // warning — turning one failure into a cascade that points away from it.
      if (previousNodeEnv !== undefined) process.env.NODE_ENV = previousNodeEnv;
      else delete process.env.NODE_ENV;
    }

    const limiter = createLimiter(CAP, "too many");
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: peer,
        configurable: true
      });
      next();
    });
    app.use("/probe", limiter.middleware);
    app.post("/probe", (req, res) => {
      limiter.recordFailure(getClientIp(req));
      res.json({ bucket: getClientIp(req), secure: req.secure });
    });

    const server = await new Promise<import("http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as { port: number };

    return {
      post: async (headers: Record<string, string>) => {
        const res = await fetch(`http://127.0.0.1:${port}/probe`, {
          method: "POST",
          headers
        });
        // Parsed defensively so an unexpected body shape surfaces as a status
        // mismatch rather than as a throw from the helper.
        const text = await res.text();
        let body: { bucket?: string; secure?: boolean } = {};
        try {
          body = JSON.parse(text) as { bucket?: string; secure?: boolean };
        } catch {
          body = {};
        }
        return { status: res.status, bucket: body.bucket, secure: body.secure };
      },
      close: () => server.close()
    };
  };

  it("keeps a peer outside the trusted range in one bucket however it rotates the headers", async () => {
    const probe = await startProbe("198.51.100.66");
    try {
      const statuses: number[] = [];
      const buckets: Array<string | undefined> = [];
      for (let i = 1; i <= CAP + 2; i++) {
        const { status, bucket } = await probe.post({
          "x-real-ip": `203.0.113.${i}`,
          "x-forwarded-for": `203.0.113.${i}`
        });
        statuses.push(status);
        if (bucket) buckets.push(bucket);
      }

      // Three allowed, then the cap holds — and every allowed request landed
      // in the peer's own address, not in the one it asked for.
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect(buckets).toEqual([
        "198.51.100.66",
        "198.51.100.66",
        "198.51.100.66"
      ]);
    } finally {
      probe.close();
    }
  });

  // The other half: behind the proxy the forwarded address must still be what
  // separates one client from another, or a single cap would cover everyone.
  it("gives each forwarded client its own bucket when the peer is the proxy", async () => {
    const probe = await startProbe("172.20.0.2");
    try {
      const first: number[] = [];
      for (let i = 1; i <= CAP + 1; i++) {
        const { status } = await probe.post({
          "x-forwarded-for": "203.0.113.9"
        });
        first.push(status);
      }
      const other = await probe.post({ "x-forwarded-for": "203.0.113.10" });

      expect(first).toEqual([200, 200, 200, 429]);
      expect([other.status, other.bucket]).toEqual([200, "203.0.113.10"]);
    } finally {
      probe.close();
    }
  });

  // The same setting governs req.secure, which express-session consults before
  // it will set a Secure cookie. A peer outside the trusted ranges therefore
  // gets no session cookie at all in production, so the proxy's own socket
  // address is a precondition of login and not only of bucket granularity.
  it("honours X-Forwarded-Proto from the proxy and ignores it from an untrusted peer", async () => {
    const fromProxy = await startProbe("172.20.0.2");
    try {
      const forwarded = await fromProxy.post({ "x-forwarded-proto": "https" });
      const plain = await fromProxy.post({});
      expect([forwarded.secure, plain.secure]).toEqual([true, false]);
    } finally {
      fromProxy.close();
    }

    const fromOutside = await startProbe("198.51.100.66");
    try {
      const forwarded = await fromOutside.post({ "x-forwarded-proto": "https" });
      expect(forwarded.secure).toBe(false);
    } finally {
      fromOutside.close();
    }
  });
});
