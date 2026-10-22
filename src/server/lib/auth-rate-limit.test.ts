import { describe, it, expect, beforeEach } from "bun:test";
import {
  isAuthRateLimited,
  normalizeAuthAccount,
  recordAuthFailure,
  resetAuthFailures,
  isRecipientProbeRateLimited,
  recordRecipientProbe,
  resetRecipientProbes,
  cleanupExpiredRateLimitRecords,
} from "./auth-rate-limit";

beforeEach(() => {
  resetAuthFailures("10.0.0.1");
  resetAuthFailures("10.0.0.2");
  resetAuthFailures("10.0.0.3");
  resetRecipientProbes("10.0.0.1");
  resetRecipientProbes("10.0.0.2");
});

const failN = async (ip: string, n: number) => {
  for (let i = 0; i < n; i++) await recordAuthFailure(ip);
};

const probeN = async (ip: string, n: number) => {
  for (let i = 0; i < n; i++) await recordRecipientProbe(ip);
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

describe("cleanupExpiredRateLimitRecords", () => {
  it("returns 0 when no records are expired", async () => {
    await recordAuthFailure("10.0.0.1");
    const cleaned = cleanupExpiredRateLimitRecords();
    expect(cleaned).toBe(0);
  });

  it("returns 0 when there are no records at all", () => {
    expect(cleanupExpiredRateLimitRecords()).toBe(0);
  });
});

describe("account-scoped auth buckets", () => {
  const failAccountN = async (ip: string, account: string, n: number) => {
    for (let i = 0; i < n; i++) await recordAuthFailure(ip, account);
  };

  it("keeps each account's failures separate under one IP", async () => {
    await failAccountN("10.0.1.1", "victim", 6);
    await failAccountN("10.0.1.1", "attacker", 3);
    // Aggregate is 9: under the threshold; the per-account buckets hold 6
    // and 3, so neither trips on its own.
    expect(isAuthRateLimited("10.0.1.1")).toBe(false);
    expect(isAuthRateLimited("10.0.1.1", "victim")).toBe(false);
    expect(isAuthRateLimited("10.0.1.1", "attacker")).toBe(false);
  }, 15_000);

  it("a success as another account does not forgive the victim's failures", async () => {
    // The bypass this scoping closes: alternate victim guesses with own
    // successful logins from the same IP. Each success must forgive only
    // the successful account's own bucket.
    await failAccountN("10.0.1.2", "victim", 9);
    resetAuthFailures("10.0.1.2", "attacker"); // attacker's own login succeeds
    expect(isAuthRateLimited("10.0.1.2", "victim")).toBe(false);
    await failAccountN("10.0.1.2", "victim", 1);
    expect(isAuthRateLimited("10.0.1.2", "victim")).toBe(true);
    expect(isAuthRateLimited("10.0.1.2")).toBe(true);
  }, 15_000);

  it("scoped reset clears only the account's own bucket; the aggregate keeps accumulating", async () => {
    await failAccountN("10.0.1.3", "victim", 5);
    await failAccountN("10.0.1.3", "attacker", 4);
    resetAuthFailures("10.0.1.3", "attacker");
    expect(isAuthRateLimited("10.0.1.3", "attacker")).toBe(false);
    expect(isAuthRateLimited("10.0.1.3", "victim")).toBe(false);
    // The aggregate (9) was untouched by the scoped reset: one more failure
    // from any account trips the per-IP ceiling.
    await failAccountN("10.0.1.3", "victim", 1);
    expect(isAuthRateLimited("10.0.1.3")).toBe(true);
  }, 15_000);

  it("whole-IP reset still clears every bucket under the IP", async () => {
    await failAccountN("10.0.1.4", "victim", 6);
    await failAccountN("10.0.1.4", "attacker", 4);
    expect(isAuthRateLimited("10.0.1.4")).toBe(true);
    resetAuthFailures("10.0.1.4");
    expect(isAuthRateLimited("10.0.1.4")).toBe(false);
    expect(isAuthRateLimited("10.0.1.4", "victim")).toBe(false);
    expect(isAuthRateLimited("10.0.1.4", "attacker")).toBe(false);
  }, 15_000);

  it("normalizes the account so case/whitespace rotation buys no fresh bucket", () => {
    expect(normalizeAuthAccount("  Victim ")).toBe("victim");
    expect(normalizeAuthAccount("")).toBe(undefined);
  });
});

describe("recipient probe budget", () => {
  it("returns false for a fresh IP", () => {
    expect(isRecipientProbeRateLimited("10.0.0.1")).toBe(false);
  });

  it("returns false below the threshold", async () => {
    await probeN("10.0.0.1", 9);
    expect(isRecipientProbeRateLimited("10.0.0.1")).toBe(false);
  }, 10000);

  it("returns true at the threshold", async () => {
    await probeN("10.0.0.1", 10);
    expect(isRecipientProbeRateLimited("10.0.0.1")).toBe(true);
  }, 10000);

  it("answers true on the call that reaches the threshold", async () => {
    await probeN("10.0.0.1", 9);
    expect(await recordRecipientProbe("10.0.0.1")).toBe(true);
  }, 10000);

  it("tracks each IP separately", async () => {
    await probeN("10.0.0.1", 10);
    expect(isRecipientProbeRateLimited("10.0.0.2")).toBe(false);
  }, 10000);

  // The two budgets answer different questions — a credential and a mailbox —
  // so spending one must not refuse the other. Sharing a counter would let a
  // recipient probe lock a legitimate sender out of AUTH.
  it("does not spend the auth budget", async () => {
    await probeN("10.0.0.1", 10);
    expect(isAuthRateLimited("10.0.0.1")).toBe(false);
  }, 10000);

  it("is not spent by the auth budget", async () => {
    await failN("10.0.0.1", 10);
    expect(isRecipientProbeRateLimited("10.0.0.1")).toBe(false);
  }, 10000);

  it("resets on demand", async () => {
    await probeN("10.0.0.1", 10);
    resetRecipientProbes("10.0.0.1");
    expect(isRecipientProbeRateLimited("10.0.0.1")).toBe(false);
  }, 10000);
});
