import { describe, it, expect, afterEach, afterAll } from "bun:test";
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

describe("server source", () => {
  // `Bun.Glob` rather than `fs.readdirSync`, and `Bun.file` rather than
  // `fs.readFileSync`: two sibling test files (`mails/mailgun.test.ts`,
  // `http/routes/health.test.ts`) do `mock.module("fs", …)`, which is
  // process-global in Bun and can replace this file's `fs` bindings under some
  // full-suite orderings. The `Bun.*` namespace is not on the `fs` module
  // surface, so it cannot be swapped out — the convention `placement.test.ts`
  // states verbatim.
  //
  // `dot: true` because the walk this replaced was directory-visibility blind,
  // and so is `Bun.build` — it follows imports, so a dot-read under a
  // `.generated/` directory would ship folded past a guard that skipped it.
  const sourceFiles = (dir: string): string[] =>
    [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: dir, absolute: true, dot: true })].filter(
      (file) => !/\.test\.tsx?$/.test(file)
    );

  // The bundling guard below only covers env.ts. A dot-access read written
  // anywhere else folds to a literal in the artifact while every test that
  // exercises the source still passes, which is how these branches went
  // unnoticed. config.ts destructures, so it does not match.
  //
  // `src/common` is walked alongside `src/server` because it is bundled into
  // the same artifact — `pack.ts` entrypoints `start.ts` with no `external`,
  // and 20+ server modules import `common`, so a fold there ships in
  // `bundle.js` exactly like a server-side one. `src/client` is deliberately
  // out of scope: that is a vite bundle where the replacement is intended.
  it("reads NODE_ENV only through env.ts", async () => {
    const srcDir = path.resolve(import.meta.dir, "../..");
    const envModule = path.resolve(import.meta.dir, "env.ts");
    const candidates = [
      ...sourceFiles(path.join(srcDir, "server")),
      ...sourceFiles(path.join(srcDir, "common"))
    ].filter((file) => file !== envModule);

    const offenders: string[] = [];
    for (const file of candidates) {
      const source = await Bun.file(file).text();
      if (/process\.env\.NODE_ENV/.test(source)) offenders.push(path.relative(srcDir, file));
    }

    expect(offenders).toEqual([]);
  });
});

describe("bundled env module", () => {
  // Under the gitignored `build/`, not `os.tmpdir()`, so the throwaway bundle
  // is created and removed without an `fs` import (see the note above).
  // Suffixed with the pid to keep the per-process uniqueness `mkdtempSync`
  // used to give: a second `bun test` on the same checkout would otherwise
  // `rm -rf` this directory while the first is still writing into it.
  const outdir = path.resolve(import.meta.dir, `../../../build/test-env-bundle-${process.pid}`);

  afterEach(restoreNodeEnv);
  afterAll(async () => {
    await Bun.$`rm -rf ${outdir}`.quiet();
  });

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
