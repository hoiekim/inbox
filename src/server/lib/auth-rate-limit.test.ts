import { describe, it, expect, beforeEach } from "bun:test";
import {
  isAuthRateLimited,
  recordAuthFailure,
  resetAuthFailures,
  cleanupExpiredAuthAttempts,
} from "./auth-rate-limit";

beforeEach(() => {
  resetAuthFailures("10.0.0.1");
  resetAuthFailures("10.0.0.2");
  resetAuthFailures("10.0.0.3");
});

const failN = async (ip: string, n: number) => {
  for (let i = 0; i < n; i++) await recordAuthFailure(ip);
};

describe("isAuthRateLimited", () => {
  it("returns false for a fresh IP", () => {
    expect(isAuthRateLimited("10.0.0.1")).toBe(false);
  });

  it("returns false after fewer than 10 failures", async () => {
    await failN("10.0.0.1", 3);
    expect(isAuthRateLimited("10.0.0.1")).toBe(false);
  }, 10_000);

  it(
    "returns true after MAX_FAILURES (10) failures",
    async () => {
      await failN("10.0.0.1", 10);
      expect(isAuthRateLimited("10.0.0.1")).toBe(true);
    },
    15_000,
  );
});

describe("recordAuthFailure", () => {
  it("returns false before threshold is reached", async () => {
    const result = await recordAuthFailure("10.0.0.2");
    expect(result).toBe(false);
  });

  it(
    "returns true on the 10th failure (threshold hit)",
    async () => {
      await failN("10.0.0.2", 9);
      const result = await recordAuthFailure("10.0.0.2");
      expect(result).toBe(true);
    },
    15_000,
  );

  it("tracks failures per IP independently", async () => {
    await failN("10.0.0.2", 2);
    await failN("10.0.0.3", 1);
    expect(isAuthRateLimited("10.0.0.2")).toBe(false);
    expect(isAuthRateLimited("10.0.0.3")).toBe(false);
  }, 10_000);
});

describe("resetAuthFailures", () => {
  it(
    "clears the counter so the IP is no longer limited",
    async () => {
      await failN("10.0.0.1", 10);
      expect(isAuthRateLimited("10.0.0.1")).toBe(true);

      resetAuthFailures("10.0.0.1");
      expect(isAuthRateLimited("10.0.0.1")).toBe(false);
    },
    15_000,
  );

  it("is a no-op for unknown IPs", () => {
    resetAuthFailures("192.168.99.99");
    expect(isAuthRateLimited("192.168.99.99")).toBe(false);
  });
});

describe("cleanupExpiredAuthAttempts", () => {
  it("returns 0 when no records are expired", async () => {
    await recordAuthFailure("10.0.0.1");
    const cleaned = cleanupExpiredAuthAttempts();
    expect(cleaned).toBe(0);
  });

  it("returns 0 when there are no records at all", () => {
    expect(cleanupExpiredAuthAttempts()).toBe(0);
  });
});
