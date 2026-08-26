import { describe, it, expect, afterEach } from "bun:test";
import { getDomain, getUserDomain, withTimeout } from "./util";

describe("getDomain", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("returns EMAIL_DOMAIN env var when set", () => {
    process.env.EMAIL_DOMAIN = "example.com";
    expect(getDomain()).toBe("example.com");
  });

  it("returns 'mydomain' as default when EMAIL_DOMAIN is unset", () => {
    delete process.env.EMAIL_DOMAIN;
    expect(getDomain()).toBe("mydomain");
  });
});

describe("getUserDomain", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("returns base domain for admin user", () => {
    process.env.EMAIL_DOMAIN = "example.com";
    expect(getUserDomain("admin")).toBe("example.com");
  });

  it("returns subdomain for regular user", () => {
    process.env.EMAIL_DOMAIN = "example.com";
    expect(getUserDomain("alice")).toBe("alice.example.com");
  });

  it("uses default domain when EMAIL_DOMAIN is unset", () => {
    delete process.env.EMAIL_DOMAIN;
    expect(getUserDomain("bob")).toBe("bob.mydomain");
  });
});

// Both call sites are on a shutdown path: `bootMaintenance`'s alarm delivery
// and the crash handler's `pool.end()`. A hung one holds the stop open until
// the container's grace period expires and SIGKILL replaces the clean exit —
// which no shutdown test can observe, so the ceiling is pinned here.
describe("withTimeout", () => {
  it("resolves undefined when the promise never settles", async () => {
    expect(await withTimeout(new Promise(() => {}), 1)).toBeUndefined();
  });

  it("passes the value through when the promise settles first", async () => {
    expect(await withTimeout(Promise.resolve("done"), 1_000)).toBe("done");
  });

  it("propagates a rejection rather than swallowing it into the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });

  // An uncleared timer keeps the event loop alive for the full ceiling after
  // the work is already done, so a 5s backstop would add 5s to every clean stop.
  it("clears its timer once the promise wins", async () => {
    const pending = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = realSetTimeout(fn, ms);
      pending.add(id);
      return id;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: Parameters<typeof globalThis.clearTimeout>[0]) => {
      pending.delete(id);
      return realClearTimeout(id);
    }) as typeof globalThis.clearTimeout;

    try {
      await withTimeout(Promise.resolve("done"), 60_000);
      expect(pending.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
