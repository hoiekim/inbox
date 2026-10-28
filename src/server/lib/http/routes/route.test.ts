import { describe, it, expect, mock, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("../../logger", () => ({
  logger: { debug: mock(() => {}), info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
}));
mock.module("../../alarm", () => ({
  sendAlarm: mock(async () => {}),
}));

// `mock.module` is process-global with no unmock API — hand the real modules
// back so the next file in the same run does not inherit these stubs.
afterAll(() => {
  const realServer = (globalThis as Record<string, unknown>).__REAL_SERVER as
    | Record<string, unknown>
    | undefined;
  if (realServer) {
    mock.module("../../logger", () => ({ logger: realServer.logger, default: realServer.logger }));
  }
  const realAlarm = (globalThis as Record<string, unknown>).__REAL_ALARM;
  if (realAlarm) mock.module("../../alarm", () => realAlarm);
});

import {
  Route,
  StreamingStatus,
  authRequired,
  dispatch,
  mountedPath,
  AUTH_ERROR_MESSAGE,
} from "./route";
import type { HttpRequest } from "../request";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    session: {},
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as HttpRequest;

// ── StreamingStatus ───────────────────────────────────────────────────────────

describe("StreamingStatus", () => {
  it("returns 'streaming' while under limit", () => {
    const s = new StreamingStatus(3);
    expect(s.get()).toBe("streaming");
    expect(s.get()).toBe("streaming");
  });

  it("returns 'success' when limit is reached", () => {
    const s = new StreamingStatus(2);
    s.get(); // 1
    expect(s.get()).toBe("success"); // 2 == limit
  });

  it("defaults limit to 1 → first call returns 'success'", () => {
    const s = new StreamingStatus();
    expect(s.get()).toBe("success");
  });
});

// ── Route.handler ─────────────────────────────────────────────────────────────

describe("Route.handler", () => {
  it("responds with the json result", async () => {
    const route = new Route("GET", "/test", async () => ({ status: "success" as const, body: { hello: "world" } }));

    const res = await route.handler(makeReq());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ status: "success", body: { hello: "world" } });
  });

  it("answers an empty 200 when the callback returns nothing (void)", async () => {
    const route = new Route("POST", "/test", async () => undefined);

    const res = await route.handler(makeReq({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("streams a file as the raw body, validated by its size and mtime", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-file-"));
    const filePath = path.join(dir, "bin");
    fs.writeFileSync(filePath, "binary data");
    try {
      const file = Bun.file(filePath);
      // A handler that read the file into memory first would hit one of these.
      for (const read of ["arrayBuffer", "bytes", "text", "json", "stream"]) {
        Object.defineProperty(file, read, {
          value: () => {
            throw new Error(`file was read through ${read}()`);
          },
        });
      }
      const route = new Route<Bun.BunFile>("GET", "/bin", async () => file);

      const res = await route.handler(makeReq());

      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("etag")).toBe(`W/"b-${file.lastModified.toString(16)}"`);
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("binary data");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 500 json on thrown error", async () => {
    const route = new Route("GET", "/boom", async () => {
      throw new Error("kaboom");
    });

    const res = await route.handler(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "error", message: "Internal server error" });
  });

  it.each(["production", "development", "test", undefined])(
    "withholds the thrown error's message from the body when NODE_ENV is %p",
    async (nodeEnv) => {
      const origEnv = process.env.NODE_ENV;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      const route = new Route("GET", "/boom-env", async () => {
        throw new Error('relation "sessions" does not exist');
      });

      let body: unknown;
      try {
        body = await (await route.handler(makeReq())).json();
      } finally {
        if (origEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = origEnv;
      }

      expect(body).toEqual({ status: "error", message: "Internal server error" });
      expect(JSON.stringify(body)).not.toContain("sessions");
    }
  );
});

// ── Route.match / dispatch ────────────────────────────────────────────────────

describe("Route.match", () => {
  it("answers only its own verb, and HEAD for a GET route", () => {
    const get = new Route("GET", "/login", async () => undefined);
    const post = new Route("POST", "/login", async () => undefined);

    expect([get.match("GET", "/login"), get.match("HEAD", "/login"), get.match("POST", "/login")]).toEqual([
      {},
      {},
      undefined,
    ]);
    expect(post.match("HEAD", "/login")).toBeUndefined();
  });

  it("matches the whole path, not a prefix (the #505 cause)", () => {
    const deleteMail = new Route("DELETE", "/:id", async () => undefined);
    const deleteEntry = new Route("DELETE", "/spam-allowlist/:pattern", async () => undefined);

    expect(deleteMail.match("DELETE", "/spam-allowlist/a%40b.c")).toBeUndefined();
    expect(deleteEntry.match("DELETE", "/spam-allowlist/a%40b.c")).toEqual({ pattern: "a@b.c" });
  });

  it("ignores case and a trailing slash", () => {
    const route = new Route("GET", "/headers/:account", async () => undefined);
    expect(route.match("GET", "/Headers/Alice%40x.y/")).toEqual({ account: "Alice@x.y" });
    expect(route.match("GET", "/headers/")).toBeUndefined();
  });

  it("refuses a param that does not decode, as a client error", () => {
    const route = new Route("GET", "/refresh/:id", async () => undefined);
    expect(() => route.match("GET", "/refresh/%E0%A4")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("dispatch", () => {
  it("runs the first route that answers, with its params on the request", async () => {
    const seen: string[] = [];
    const routes = [
      new Route("GET", "/a/:id", async (req) => {
        seen.push(`a:${req.params.id}`);
        return { status: "success" as const };
      }),
      new Route("GET", "/:any/:id", async () => {
        seen.push("fallback");
        return { status: "success" as const };
      }),
    ];

    const res = await dispatch(routes, makeReq(), "/a/7");
    expect(res?.status).toBe(200);
    expect(seen).toEqual(["a:7"]);
    expect(await dispatch(routes, makeReq({ method: "POST" }), "/a/7")).toBeUndefined();
  });
});

describe("mountedPath", () => {
  it("strips a matching mount prefix, ignoring case", () => {
    expect([
      mountedPath("/users/login", "/users"),
      mountedPath("/Users", "/users"),
      mountedPath("/users/", "/users"),
      mountedPath("/usersx", "/users"),
      mountedPath("/mails", "/users"),
    ]).toEqual(["/login", "/", "/", undefined, undefined]);
  });
});

// ── authRequired ──────────────────────────────────────────────────────────────

describe("authRequired", () => {
  it("lets the request through when session.user is set", () => {
    const req = makeReq({ session: { user: { id: "u1", username: "alice" } } });

    expect(authRequired(req)).toBeUndefined();
  });

  it("returns 401 when session.user is absent", async () => {
    const res = authRequired(makeReq({ session: {} }));

    expect(res?.status).toBe(401);
    expect(await res?.json()).toMatchObject({ status: "failed", message: AUTH_ERROR_MESSAGE });
  });
});
