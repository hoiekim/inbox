import { describe, it, expect } from "bun:test";
import { logger } from "../logger";

type Warning = { message: string; context?: Record<string, unknown> };

/**
 * Runs `fn` with SECRET/NODE_ENV set to the given values and `logger.warn`
 * captured, restoring both afterwards. Assigning over the exported logger's
 * method keeps this out of `mock.module`, which is process-global and would
 * bleed into every other suite.
 */
const withEnv = async <T>(
  env: { SECRET?: string; NODE_ENV?: string },
  fn: (warnings: Warning[]) => T | Promise<T>
): Promise<T> => {
  const saved = { SECRET: process.env["SECRET"], NODE_ENV: process.env["NODE_ENV"] };
  const savedWarn = logger.warn;
  const warnings: Warning[] = [];
  for (const key of ["SECRET", "NODE_ENV"] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  logger.warn = ((message: string, context?: Record<string, unknown>) => {
    warnings.push({ message, context });
  }) as typeof logger.warn;
  try {
    return await fn(warnings);
  } finally {
    logger.warn = savedWarn;
    for (const key of ["SECRET", "NODE_ENV"] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const STRONG_SECRET = "Yx0pQ7bH2mV9sLd4TnR6wCzE8fJaUgKiPo1ZvXbNqMs=";

describe("resolveSessionSecret in production", () => {
  it("throws when SECRET is unset", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: "production" }, () => {
      expect(() => resolveSessionSecret()).toThrow(/SECRET is not set/);
    });
  });

  it("throws when SECRET is whitespace only", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "   \t ", NODE_ENV: "production" }, () => {
      expect(() => resolveSessionSecret()).toThrow(/SECRET is not set/);
    });
  });

  it("throws on the literal the server used to fall back to", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "secret", NODE_ENV: "production" }, () => {
      expect(() => resolveSessionSecret()).toThrow(/published in this repository/);
    });
  });

  it("throws on the value .env.example ships", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "inbox", NODE_ENV: "production" }, () => {
      expect(() => resolveSessionSecret()).toThrow(/published in this repository/);
    });
  });

  it("throws on the development fallback, so it cannot be copied into a deployment", async () => {
    const { resolveSessionSecret, DEVELOPMENT_FALLBACK } = await import("./session-secret");
    await withEnv({ SECRET: DEVELOPMENT_FALLBACK, NODE_ENV: "production" }, () => {
      expect(() => resolveSessionSecret()).toThrow(/published in this repository/);
    });
  });

  it("returns a private secret unchanged and warns about nothing", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: STRONG_SECRET, NODE_ENV: "production" }, (warnings) => {
      expect(resolveSessionSecret()).toBe(STRONG_SECRET);
      expect(warnings).toEqual([]);
    });
  });

  it("warns but does not refuse a short private secret", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "k7Qv2Lm9Xt", NODE_ENV: "production" }, (warnings) => {
      expect(resolveSessionSecret()).toBe("k7Qv2Lm9Xt");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/shorter than the recommended 32 characters/);
      expect(warnings[0]?.context).toEqual({ length: 10 });
    });
  });

  it("returns the secret untrimmed so existing cookies keep verifying", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    const padded = ` ${STRONG_SECRET} `;
    await withEnv({ SECRET: padded, NODE_ENV: "production" }, (warnings) => {
      expect(resolveSessionSecret()).toBe(padded);
      expect(warnings).toEqual([]);
    });
  });
});

describe("resolveSessionSecret outside production", () => {
  it("warns and returns a key that is not the old fallback when SECRET is unset", async () => {
    const { resolveSessionSecret, DEVELOPMENT_FALLBACK } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: "test" }, (warnings) => {
      const resolved = resolveSessionSecret();
      expect(resolved).toBe(DEVELOPMENT_FALLBACK);
      expect(resolved).not.toBe("secret");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/SECRET is not set/);
    });
  });

  it("does not throw when NODE_ENV is absent entirely", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: undefined }, (warnings) => {
      expect(resolveSessionSecret()).not.toBe("secret");
      expect(warnings).toHaveLength(1);
    });
  });

  it("warns about a published value but still honours it", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "inbox", NODE_ENV: "test" }, (warnings) => {
      expect(resolveSessionSecret()).toBe("inbox");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/published in this repository/);
    });
  });

  it("accepts a private secret silently", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: STRONG_SECRET, NODE_ENV: "test" }, (warnings) => {
      expect(resolveSessionSecret()).toBe(STRONG_SECRET);
      expect(warnings).toEqual([]);
    });
  });
});
