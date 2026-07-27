import { describe, it, expect } from "bun:test";
import { Throttler } from "./throttler";

describe("Throttler", () => {
  it("reports 0 wait while under the limit", () => {
    const throttler = new Throttler(3, 1000);
    expect(throttler.msUntilFree()).toBe(0);
    throttler.record();
    throttler.record();
    expect(throttler.msUntilFree()).toBe(0);
  });

  it("reports a positive wait once the window is full", () => {
    const throttler = new Throttler(2, 1000);
    throttler.record();
    throttler.record();
    const wait = throttler.msUntilFree();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
  });

  it("does not record when peeking", () => {
    const throttler = new Throttler(2, 1000);
    // Peeking many times must never consume capacity.
    for (let i = 0; i < 10; i++) {
      expect(throttler.msUntilFree()).toBe(0);
    }
    throttler.record();
    expect(throttler.msUntilFree()).toBe(0);
  });

  it("frees a slot after the window elapses", async () => {
    const throttler = new Throttler(1, 30);
    throttler.record();
    expect(throttler.msUntilFree()).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(throttler.msUntilFree()).toBe(0);
  });

  it("wait time reflects the oldest blocking request", async () => {
    const throttler = new Throttler(2, 100);
    throttler.record();
    await new Promise((resolve) => setTimeout(resolve, 30));
    throttler.record();
    // The first record is the blocking one; it expires ~70ms from now.
    const wait = throttler.msUntilFree();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(80);
  });
});
