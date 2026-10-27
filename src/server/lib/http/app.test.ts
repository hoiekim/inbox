import { describe, it, expect, afterEach } from "bun:test";
import path from "path";

import { resolveProxyTrust } from "./app";
import type { ProxyTrust } from "./request";

const originalNodeEnv = process.env.NODE_ENV;
const restoreNodeEnv = () => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
};

const PEERS = [
  "127.0.0.1",
  "::ffff:127.0.0.1",
  "::1",
  "10.1.2.3",
  "172.18.0.2",
  "192.168.1.9",
  "fd00::7",
  "203.0.113.9",
  "::ffff:203.0.113.9",
];

const trustedPeers = (trust: ProxyTrust) => PEERS.filter((peer) => trust(peer));

describe("resolveProxyTrust", () => {
  afterEach(restoreNodeEnv);

  it("resolves the trusted-proxy list from the environment it is called in", () => {
    process.env.NODE_ENV = "production";
    const prod = resolveProxyTrust();
    process.env.NODE_ENV = "development";
    const dev = resolveProxyTrust();

    // Production trusts loopback and private addresses by ADDRESS, so a public
    // peer that never passed the proxy cannot name its own `req.ip`; outside
    // production no peer is trusted at all.
    expect(trustedPeers(prod)).toEqual([
      "127.0.0.1",
      "::ffff:127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.18.0.2",
      "192.168.1.9",
      "fd00::7",
    ]);
    expect(trustedPeers(dev)).toEqual([]);
  });

  it("trusts nothing that is not an address", () => {
    process.env.NODE_ENV = "production";
    const trust = resolveProxyTrust();
    expect(["", "unknown", "localhost", "127.1"].filter((peer) => trust(peer))).toEqual([]);
  });
});

describe("bundled resolveProxyTrust", () => {
  afterEach(restoreNodeEnv);

  // Unbundled, a `process.env.NODE_ENV` read is decided at run time anyway; the
  // fold into a literal only happens at build time. Building the module the way
  // `pack.ts` does is the only place that defect is observable.
  it("still answers to the runtime NODE_ENV after bundling", async () => {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "app.ts")],
      target: "bun",
    });
    expect(result.success).toBe(true);

    // Written through Bun.write rather than node:fs — a module-scoped
    // fs/os call is resolved against whatever another suite's process-global
    // mock.module left in place, which silently skipped this whole describe
    // in a full-directory run.
    const outfile = path.join("/tmp", `inbox-http-app-${process.pid}`, "app.js");
    await Bun.write(outfile, result.outputs[0]!);
    const bundled = await import(outfile);

    process.env.NODE_ENV = "production";
    const prod = bundled.resolveProxyTrust();
    process.env.NODE_ENV = "development";
    const dev = bundled.resolveProxyTrust();

    expect([prod("10.1.2.3"), dev("10.1.2.3")]).toEqual([true, false]);
  });
});
