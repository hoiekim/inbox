import { afterAll, describe, expect, it, mock } from "bun:test";
import { restoreLeaves } from "test-helpers";

afterAll(restoreLeaves);

describe("restoreLeaves", () => {
  it("puts the full pool-driver namespace back after a wholesale stub", async () => {
    class StubPool {}
    mock.module("server/lib/postgres/pool", () => ({ Pool: StubPool }));

    const stubbed = (await import("server/lib/postgres/pool")) as unknown as Record<string, unknown>;
    expect(stubbed.Pool).toBe(StubPool);

    restoreLeaves();

    const restored = await import("server/lib/postgres/pool");
    expect(restored.Pool).not.toBe(StubPool);
    expect(typeof restored.Pool.prototype.connect).toBe("function");
    expect(new restored.DatabaseError({ errno: "23505", message: "duplicate" }).code).toBe("23505");
  });
});
