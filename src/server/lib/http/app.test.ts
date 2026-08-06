import { describe, it, expect, afterEach } from "bun:test";
import { json } from "express";
import type { Server } from "http";
import path from "path";

import { createExpressApp } from "./app";

const originalNodeEnv = process.env.NODE_ENV;
const restoreNodeEnv = () => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
};

describe("createExpressApp", () => {
  afterEach(restoreNodeEnv);

  it("resolves both runtime settings from the environment it is called in", () => {
    process.env.NODE_ENV = "production";
    const prod = createExpressApp();
    process.env.NODE_ENV = "development";
    const dev = createExpressApp();

    // `false` is express's own default for trust proxy — asserted rather than
    // omitted so a stray unconditional `app.set("trust proxy", 1)` fails here.
    expect([
      prod.get("env"),
      prod.get("trust proxy"),
      dev.get("env"),
      dev.get("trust proxy")
    ]).toEqual(["production", 1, "development", false]);
  });

  // The consequence the `env` setting exists for, driven over a real socket
  // rather than asserted on the setting alone: finalhandler decides from
  // `app.get("env")` whether an unhandled error's stack goes into the response
  // body. A malformed-JSON POST reaches it with no authentication.
  it("does not disclose a stack trace on a malformed body in production", async () => {
    process.env.NODE_ENV = "production";
    const app = createExpressApp();
    app.use(json());
    app.post("/probe", (_req, res) => res.send("ok"));

    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json"
      });
      const body = await res.text();

      expect(res.status).toBe(400);
      expect([
        body.includes("SyntaxError"),
        body.includes("at "),
        body.includes(".js:")
      ]).toEqual([false, false, false]);
    } finally {
      server?.close();
    }
  });
});

describe("bundled createExpressApp", () => {
  afterEach(restoreNodeEnv);

  // The two cases above cannot fail for the bug this guards. Unbundled, express
  // seeds `env` correctly from its own `process.env.NODE_ENV` read, so deleting
  // our explicit set changes nothing — the fold only happens at build time.
  // Building the module the way `pack.ts` does is the only place the defect is
  // observable, which is why the source-level suite missed it originally.
  it("still answers to the runtime NODE_ENV after bundling", async () => {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "app.ts")],
      target: "node"
    });
    expect(result.success).toBe(true);

    // Written through Bun.write rather than node:fs — a module-scoped
    // fs/os call is resolved against whatever another suite's process-global
    // mock.module left in place, which silently skipped this whole describe
    // in a full-directory run.
    const outfile = path.join(
      "/tmp",
      `inbox-http-app-${process.pid}`,
      "app.js"
    );
    await Bun.write(outfile, result.outputs[0]!);
    const bundled = await import(outfile);

    process.env.NODE_ENV = "production";
    const prod = bundled.createExpressApp();
    process.env.NODE_ENV = "development";
    const dev = bundled.createExpressApp();

    expect([prod.get("env"), dev.get("env")]).toEqual([
      "production",
      "development"
    ]);
  });
});
