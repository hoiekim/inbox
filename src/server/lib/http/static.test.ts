import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { serveIndex, serveStatic } from "./static";

// <parent>/secret.txt sits beside the served root, <parent>/client.
const parent = mkdtempSync(path.join(tmpdir(), "static-test-"));
const root = path.join(parent, "client");
mkdirSync(path.join(root, "assets"), { recursive: true });
mkdirSync(path.join(root, ".git"), { recursive: true });
writeFileSync(path.join(parent, "secret.txt"), "outside the root");
writeFileSync(path.join(root, "index.html"), "<!doctype html><title>app</title>");
writeFileSync(path.join(root, "assets", "app.js"), "console.log('app');");
writeFileSync(path.join(root, "assets", ".hidden"), "dotfile in a subdirectory");
writeFileSync(path.join(root, ".env"), "not for the browser");
writeFileSync(path.join(root, ".git", "config"), "[core]");

afterAll(() => rmSync(parent, { recursive: true, force: true }));

const serve = (urlPath: string) => serveStatic(root, urlPath, false);

describe("serveStatic", () => {
  it("serves a file under the root, and the entry document for the fallback", async () => {
    const asset = await serve("/assets/app.js");
    expect([asset?.status, await asset?.text()]).toEqual([200, "console.log('app');"]);
    expect(asset?.headers.get("cache-control")).toBe("public, max-age=0");

    const index = await serveIndex(root, false);
    expect(await index?.text()).toBe("<!doctype html><title>app</title>");
    expect(await serve("/assets/missing.js")).toBeUndefined();
  });

  it.each([
    "/%2e%2e/secret.txt",
    "/%2E%2E/secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/..%2Fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/..%5csecret.txt",
    "/assets/..%5c..%5csecret.txt",
  ])("refuses a parent-directory segment: %s", async (urlPath) => {
    expect(await serve(urlPath)).toBeUndefined();
  });

  it.each(["/%252e%252e/secret.txt", "/%252e%252e%252fsecret.txt"])(
    "decodes only once, so a double-encoded segment names a literal path: %s",
    async (urlPath) => {
      expect(await serve(urlPath)).toBeUndefined();
    }
  );

  it.each(["/.env", "/%2eenv", "/.git/config", "/%2Egit/config", "/assets/.hidden"])(
    "refuses a dotfile or dot-directory: %s",
    async (urlPath) => {
      expect(await serve(urlPath)).toBeUndefined();
    }
  );

  it("refuses a path that does not decode, and one with a NUL byte", async () => {
    expect(await serve("/%E0%A4")).toBeUndefined();
    expect(await serve("/index.html%00.js")).toBeUndefined();
  });
});
