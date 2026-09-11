import { afterAll, describe, expect, it, mock } from "bun:test";
import { restoreLeaves } from "test-helpers";

afterAll(restoreLeaves);

describe("restoreLeaves", () => {
  it("puts the full bcryptjs namespace back after a wholesale stub", async () => {
    const stub = mock(async () => false);
    mock.module("bcryptjs", () => ({
      default: { compare: stub },
      compare: stub,
    }));

    const stubbed = (await import("bcryptjs")).default as unknown as Record<string, unknown>;
    expect(Object.keys(stubbed)).toEqual(["compare"]);

    restoreLeaves();

    const restored = (await import("bcryptjs")).default;
    const hash = await restored.hash("hunter2", 10);
    expect(await restored.compare("hunter2", hash)).toBe(true);
    expect(await restored.compare("wrong", hash)).toBe(false);
  });
});
