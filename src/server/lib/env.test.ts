import { describe, it, expect, afterEach, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { isProduction, nodeEnv } from "./env";

const originalNodeEnv = process.env.NODE_ENV;

const restoreNodeEnv = () => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
};

describe("nodeEnv", () => {
  afterEach(restoreNodeEnv);

  it("reads NODE_ENV on every call, not once at import", () => {
    process.env.NODE_ENV = "production";
    expect(nodeEnv()).toBe("production");
    process.env.NODE_ENV = "development";
    expect(nodeEnv()).toBe("development");
  });

  it("returns undefined when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    expect(nodeEnv()).toBeUndefined();
  });
});

describe("isProduction", () => {
  afterEach(restoreNodeEnv);

  it("is true for exactly 'production'", () => {
    process.env.NODE_ENV = "production";
    expect(isProduction()).toBe(true);
  });

  it("is false for any other value", () => {
    for (const value of ["development", "test", "prod", "Production", ""]) {
      process.env.NODE_ENV = value;
      expect(isProduction()).toBe(false);
    }
  });

  it("is false when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    expect(isProduction()).toBe(false);
  });
});

describe("bundled env module", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-env-bundle-"));

  afterEach(restoreNodeEnv);
  afterAll(() => fs.rmSync(outdir, { recursive: true, force: true }));

  // The server ships as a Bun bundle, so the checks above passing against the
  // source proves nothing about the artifact: Bun constant-folds
  // `process.env.NODE_ENV` at build time. Build this module the way `pack.ts`
  // does and assert the result still answers to the environment it runs in.
  it("still reads NODE_ENV at runtime after bundling", async () => {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "env.ts")],
      target: "node",
      outdir
    });
    expect(result.success).toBe(true);

    const bundled = await import(result.outputs[0]!.path);

    process.env.NODE_ENV = "production";
    expect(bundled.nodeEnv()).toBe("production");
    expect(bundled.isProduction()).toBe(true);

    process.env.NODE_ENV = "development";
    expect(bundled.nodeEnv()).toBe("development");
    expect(bundled.isProduction()).toBe(false);
  });
});
