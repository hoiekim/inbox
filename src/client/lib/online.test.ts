import { describe, it, expect } from "bun:test";

import {
  reduceOnline,
  pingHealth,
  invalidateCacheableQueries,
  formatLastSeen,
  OnlineState
} from "./online";

describe("reduceOnline", () => {
  it("stamps lastSeenOnline with `now` while online and reports no reconnect when already online", () => {
    const prev: OnlineState = { isOnline: true, lastSeenOnline: 1000 };
    const { state, reconnected } = reduceOnline(prev, true, 2000);
    expect(state).toEqual({ isOnline: true, lastSeenOnline: 2000 });
    expect(reconnected).toBe(false);
  });

  it("keeps the prior lastSeenOnline when going offline (banner shows the last good time)", () => {
    const prev: OnlineState = { isOnline: true, lastSeenOnline: 1000 };
    const { state, reconnected } = reduceOnline(prev, false, 2000);
    expect(state).toEqual({ isOnline: false, lastSeenOnline: 1000 });
    expect(reconnected).toBe(false);
  });

  it("flags reconnected only on the offline→online edge", () => {
    const offline: OnlineState = { isOnline: false, lastSeenOnline: 1000 };
    const { state, reconnected } = reduceOnline(offline, true, 5000);
    expect(state).toEqual({ isOnline: true, lastSeenOnline: 5000 });
    expect(reconnected).toBe(true);
  });

  it("preserves a null lastSeenOnline across an offline→offline tick", () => {
    const prev: OnlineState = { isOnline: false, lastSeenOnline: null };
    const { state, reconnected } = reduceOnline(prev, false, 9000);
    expect(state).toEqual({ isOnline: false, lastSeenOnline: null });
    expect(reconnected).toBe(false);
  });
});

describe("pingHealth", () => {
  it("is true when /api/health responds ok", async () => {
    let calledPath = "";
    const fakeFetch = (async (path: string) => {
      calledPath = path as string;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    expect(await pingHealth(fakeFetch)).toBe(true);
    expect(calledPath).toBe("/api/health");
  });

  it("is false when /api/health responds non-ok", async () => {
    const fakeFetch = (async () =>
      ({ ok: false }) as Response) as unknown as typeof fetch;
    expect(await pingHealth(fakeFetch)).toBe(false);
  });

  it("swallows a thrown/rejected fetch as offline rather than rejecting", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await pingHealth(fakeFetch)).toBe(false);
  });
});

describe("invalidateCacheableQueries", () => {
  it("invalidates only queries whose key is a cacheable endpoint", () => {
    let captured: ((q: { queryKey: unknown }) => boolean) | undefined;
    const fakeClient = {
      invalidateQueries: (filters: {
        predicate: (q: { queryKey: unknown }) => boolean;
      }) => {
        captured = filters.predicate;
      }
    } as unknown as Parameters<typeof invalidateCacheableQueries>[0];

    invalidateCacheableQueries(fakeClient);
    expect(captured).toBeDefined();
    const pred = captured!;

    // string-key cacheable endpoint (mail headers) → invalidate
    expect(pred({ queryKey: "/api/mails/headers/me@hoie.kim" })).toBe(true);
    // array-key form, first element is the URL → invalidate
    expect(pred({ queryKey: ["/api/mails/headers/me@hoie.kim?new=1"] })).toBe(
      true
    );
    // volatile / non-cacheable endpoints → leave alone
    expect(pred({ queryKey: "/api/mails/search/me@hoie.kim" })).toBe(false);
    expect(pred({ queryKey: "/api/mails/accounts" })).toBe(false);
    // non-string keys → leave alone
    expect(pred({ queryKey: 42 })).toBe(false);
  });
});

describe("formatLastSeen", () => {
  it("returns a dash when the server was never reached this session", () => {
    expect(formatLastSeen(null)).toBe("—");
  });

  it("renders a non-empty HH:MM clock for a real timestamp", () => {
    const out = formatLastSeen(new Date(2026, 0, 1, 9, 5).getTime());
    expect(out).toMatch(/\d/);
    expect(out.length).toBeGreaterThan(0);
  });
});
