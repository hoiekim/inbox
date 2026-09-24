import { describe, it, expect } from "bun:test";
import { logger } from "../logger";

type Warning = { message: string; context?: Record<string, unknown> };

/**
 * Runs `fn` with SECRET/NODE_ENV set to the given values and `logger.warn`/
 * `logger.error` captured, restoring both afterwards. Assigning over the
 * exported logger's methods keeps this out of `mock.module`, which is
 * process-global and would bleed into every other suite.
 */
const withEnv = async <T>(
  env: { SECRET?: string; NODE_ENV?: string },
  fn: (warnings: Warning[], errors: Warning[]) => T | Promise<T>
): Promise<T> => {
  const saved = { SECRET: process.env["SECRET"], NODE_ENV: process.env["NODE_ENV"] };
  const savedWarn = logger.warn;
  const savedError = logger.error;
  const warnings: Warning[] = [];
  const errors: Warning[] = [];
  for (const key of ["SECRET", "NODE_ENV"] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  logger.warn = ((message: string, context?: Record<string, unknown>) => {
    warnings.push({ message, context });
  }) as typeof logger.warn;
  logger.error = ((message: string, context?: Record<string, unknown>) => {
    errors.push({ message, context });
  }) as typeof logger.error;
  try {
    return await fn(warnings, errors);
  } finally {
    logger.warn = savedWarn;
    logger.error = savedError;
    for (const key of ["SECRET", "NODE_ENV"] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const STRONG_SECRET = "Yx0pQ7bH2mV9sLd4TnR6wCzE8fJaUgKiPo1ZvXbNqMs=";

/** A `notify` spy that records calls without hitting the network. */
const spyNotify = () => {
  const calls: { title: string; detail: string; key?: string }[] = [];
  const notify = async (title: string, detail: string, key?: string) => {
    calls.push({ title, detail, key });
  };
  return { notify, calls };
};

describe("resolveSessionSecret in production", () => {
  it("returns whatever generateSecret produces and alarms, when SECRET is unset", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: "production" }, (_warnings, errors) => {
      const { notify, calls } = spyNotify();
      let generateCalls = 0;
      const generateSecret = () => {
        generateCalls += 1;
        return `spy-secret-${generateCalls}`;
      };
      expect(resolveSessionSecret(generateSecret, notify)).toBe("spy-secret-1");
      expect(generateCalls).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/SECRET is not set/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.title).toBe("SECRET Misconfigured");
      expect(calls[0]?.detail).toMatch(/SECRET is not set/);
    });
  });

  it("returns whatever generateSecret produces when SECRET is whitespace only", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "   \t ", NODE_ENV: "production" }, (_warnings, errors) => {
      const { notify, calls } = spyNotify();
      expect(resolveSessionSecret(() => "spy-secret", notify)).toBe("spy-secret");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/SECRET is not set/);
      expect(calls).toHaveLength(1);
    });
  });

  it("returns whatever generateSecret produces on the development fallback, so it grants no integrity", async () => {
    const { resolveSessionSecret, DEVELOPMENT_FALLBACK } = await import("./session-secret");
    expect(DEVELOPMENT_FALLBACK).toBe("secret");
    await withEnv({ SECRET: DEVELOPMENT_FALLBACK, NODE_ENV: "production" }, (_warnings, errors) => {
      const { notify, calls } = spyNotify();
      expect(resolveSessionSecret(() => "spy-secret", notify)).toBe("spy-secret");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/published in this repository/);
      expect(calls).toHaveLength(1);
    });
  });

  it("returns whatever generateSecret produces on the value .env.example ships", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "inbox", NODE_ENV: "production" }, (_warnings, errors) => {
      const { notify, calls } = spyNotify();
      expect(resolveSessionSecret(() => "spy-secret", notify)).toBe("spy-secret");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/published in this repository/);
      expect(calls).toHaveLength(1);
    });
  });

  it("the default generator produces a distinct 32-byte key on every call, without alarming a caller that supplies its own notify", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: "production" }, () => {
      const { notify, calls } = spyNotify();
      const first = resolveSessionSecret(undefined, notify);
      const second = resolveSessionSecret(undefined, notify);
      expect(first).not.toBe(second);
      expect(Buffer.from(first, "base64").length).toBe(32);
      expect(Buffer.from(second, "base64").length).toBe(32);
      expect(calls).toHaveLength(2);
    });
  });

  it("returns a private secret unchanged and logs nothing", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: STRONG_SECRET, NODE_ENV: "production" }, (warnings, errors) => {
      expect(resolveSessionSecret()).toBe(STRONG_SECRET);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  it("warns but does not refuse a short private secret", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    await withEnv({ SECRET: "k7Qv2Lm9Xt", NODE_ENV: "production" }, (warnings, errors) => {
      expect(resolveSessionSecret()).toBe("k7Qv2Lm9Xt");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/shorter than the recommended 32 characters/);
      expect(warnings[0]?.context).toEqual({ length: 10 });
      expect(errors).toEqual([]);
    });
  });

  it("returns the secret untrimmed so existing cookies keep verifying", async () => {
    const { resolveSessionSecret } = await import("./session-secret");
    const padded = ` ${STRONG_SECRET} `;
    await withEnv({ SECRET: padded, NODE_ENV: "production" }, (warnings, errors) => {
      expect(resolveSessionSecret()).toBe(padded);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
});

describe("resolveSessionSecret outside production", () => {
  it("warns and keeps signing with the key it signed with before, when SECRET is unset", async () => {
    const { resolveSessionSecret, DEVELOPMENT_FALLBACK } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: "test" }, (warnings) => {
      expect(resolveSessionSecret()).toBe(DEVELOPMENT_FALLBACK);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/SECRET is not set/);
    });
  });

  it("does not throw when NODE_ENV is absent entirely", async () => {
    const { resolveSessionSecret, DEVELOPMENT_FALLBACK } = await import("./session-secret");
    await withEnv({ SECRET: undefined, NODE_ENV: undefined }, (warnings) => {
      expect(resolveSessionSecret()).toBe(DEVELOPMENT_FALLBACK);
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
