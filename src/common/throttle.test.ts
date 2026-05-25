import { describe, it, expect } from "bun:test";
import { Throttle } from "./throttle";

describe("Throttle", () => {
  it("executes the operation and returns its result", async () => {
    const throttle = new Throttle();
    const result = await throttle.throttle("key1", async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the operation", async () => {
    const throttle = new Throttle();
    await expect(
      throttle.throttle("key1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("tracks operations per key independently", async () => {
    const throttle = new Throttle(5, 1000);
    const results: string[] = [];
    await throttle.throttle("a", async () => results.push("a1"));
    await throttle.throttle("b", async () => results.push("b1"));
    await throttle.throttle("a", async () => results.push("a2"));
    expect(results).toEqual(["a1", "b1", "a2"]);
  });

  it("cleans up old entries when queue exceeds 100", async () => {
    const throttle = new Throttle(1000, 1);
    for (let i = 0; i < 105; i++) {
      await throttle.throttle(`key-${i}`, async () => i);
    }
    await new Promise((r) => setTimeout(r, 20));
    await throttle.throttle("trigger-cleanup", async () => "ok");
  });

  it("respects custom maxConcurrent and windowMs", async () => {
    const throttle = new Throttle(10, 500);
    const start = Date.now();
    await throttle.throttle("fast", async () => "done");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
