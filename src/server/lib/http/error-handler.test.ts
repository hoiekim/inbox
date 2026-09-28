import { describe, it, expect, mock, afterEach, beforeEach } from "bun:test";
import express from "express";
import session from "express-session";
import { createHmac } from "crypto";
import type { Request, Response } from "express";
import type { Server } from "http";

import { resetAlarmState } from "../alarm";

const makeReq = (path: string) =>
  ({
    method: "GET",
    path,
    sessionID: "sid-abc",
  }) as unknown as Request;

const makeRes = (init?: { headersSent?: boolean; writableEnded?: boolean }) => {
  const res: Record<string, unknown> = {
    headersSent: init?.headersSent ?? false,
    writableEnded: init?.writableEnded ?? false,
  };
  res.status = mock((code: number) => {
    res._code = code;
    return res;
  });
  res.json = mock((body: unknown) => {
    res._body = body;
    return res;
  });
  res.type = mock((value: string) => {
    res._type = value;
    return res;
  });
  res.send = mock((body: unknown) => {
    res._body = body;
    return res;
  });
  res.end = mock(() => res);
  return res as unknown as Response & Record<string, unknown>;
};

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

const captureErrorLogs = () => {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return lines;
};

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

describe("errorHandler", () => {
  it("answers /api/* with a 500 JSON error body", async () => {
    const { errorHandler } = await import("./error-handler");
    const res = makeRes();
    const next = mock(() => {});

    errorHandler(new Error("connection terminated unexpectedly"), makeReq("/api/mails"), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res._body).toEqual({ status: "error", message: "Internal server error" });
    expect(next).not.toHaveBeenCalled();
  });

  // The driver message names the table and column it failed on, and the
  // deployment sets no NODE_ENV — so an environment-gated body would disclose
  // it by default rather than withhold it by default.
  it("keeps the underlying driver message out of the response body", async () => {
    const { errorHandler } = await import("./error-handler");
    const apiRes = makeRes();
    const pageRes = makeRes();

    errorHandler(
      new Error('relation "sessions" does not exist'),
      makeReq("/api/mails"),
      apiRes,
      mock(() => {})
    );
    errorHandler(
      new Error('relation "sessions" does not exist'),
      makeReq("/"),
      pageRes,
      mock(() => {})
    );

    expect([JSON.stringify(apiRes._body), String(pageRes._body)]).toEqual([
      JSON.stringify({ status: "error", message: "Internal server error" }),
      "Internal server error",
    ]);
  });

  it("answers a non-API path with a plain-text 500 rather than JSON", async () => {
    const { errorHandler } = await import("./error-handler");
    const res = makeRes();
    const next = mock(() => {});

    errorHandler(new Error("connection terminated unexpectedly"), makeReq("/"), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res._type).toBe("text/plain");
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through the status an upstream middleware asked for", async () => {
    const { errorHandler } = await import("./error-handler");
    const malformed = makeRes();
    const tooLarge = makeRes();

    errorHandler(badRequest("Unexpected end of JSON input"), makeReq("/api/mails"), malformed, mock(() => {}));
    errorHandler(
      Object.assign(new Error("request entity too large"), { statusCode: 413 }),
      makeReq("/api/mails"),
      tooLarge,
      mock(() => {})
    );

    expect([malformed._code, malformed._body, tooLarge._code, tooLarge._body]).toEqual([
      400,
      { status: "error", message: "Bad Request" },
      413,
      { status: "error", message: "Payload Too Large" },
    ]);
  });

  it("treats a 5xx carried on the error as ours, not as a passthrough", async () => {
    const { errorHandler } = await import("./error-handler");
    const res = makeRes();

    errorHandler(
      Object.assign(new Error("bad gateway"), { status: 502 }),
      makeReq("/api/mails"),
      res,
      mock(() => {})
    );

    expect([res._code, res._body]).toEqual([500, { status: "error", message: "Internal server error" }]);
  });

  it("ends a headers-sent response instead of forwarding to finalhandler", async () => {
    const { errorHandler } = await import("./error-handler");
    const res = makeRes({ headersSent: true });
    const next = mock(() => {});

    errorHandler(new Error("could not serialize session write"), makeReq("/api/mails"), res, next);

    // finalhandler answers a headers-sent error by destroying the socket,
    // which truncates a body that has already begun streaming.
    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-ended response alone", async () => {
    const { errorHandler } = await import("./error-handler");
    const res = makeRes({ headersSent: true, writableEnded: true });
    const next = mock(() => {});

    errorHandler(new Error("could not serialize session write"), makeReq("/api/mails"), res, next);

    expect(res.end).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("logs the failing request and its session id", async () => {
    const { errorHandler } = await import("./error-handler");
    const lines = captureErrorLogs();

    errorHandler(new Error("connection terminated unexpectedly"), makeReq("/api/mails"), makeRes(), mock(() => {}));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Unhandled middleware error");
    expect(lines[0]).toContain("sid-abc");
    expect(lines[0]).toContain("/api/mails");
  });

  it("does not log a client error as a server fault", async () => {
    const { errorHandler } = await import("./error-handler");
    const lines = captureErrorLogs();

    errorHandler(badRequest("Unexpected end of JSON input"), makeReq("/api/mails"), makeRes(), mock(() => {}));

    expect(lines).toEqual([]);
  });
});

/**
 * The properties below cannot be observed on the exported function: that the
 * handler is *registered* in the app the server actually runs, that an error
 * raised upstream of `app.use("/api", apiRouter)` skips that layer and reaches
 * it, and that it alarms. Each one is asserted against the real chain, with
 * only the session store swapped out.
 */
const SECRET = "error-handler-test-secret-not-published-0123456789";

const signCookie = (value: string) =>
  `s:${value}.${createHmac("sha256", SECRET).update(value).digest("base64").replace(/=+$/, "")}`;

class FaultingStore extends session.Store {
  get(_id: string, callback: (err?: unknown, data?: session.SessionData | null) => void) {
    callback(new Error("connection terminated unexpectedly"));
  }
  set(_id: string, _data: session.SessionData, callback?: (err?: unknown) => void) {
    callback?.();
  }
  destroy(_id: string, callback?: (err?: unknown) => void) {
    callback?.();
  }
}

const listen = async (app: express.Application) => {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** Stands in for the Discord webhook so a real `sendAlarm` is observable. */
const startAlarmSink = async () => {
  const received: Array<Record<string, unknown>> = [];
  let announce: (() => void) | undefined;
  const app = express();
  app.use(express.json());
  app.post("/hook", (req, res) => {
    received.push(req.body as Record<string, unknown>);
    res.status(204).end();
    announce?.();
  });
  const { server, baseUrl } = await listen(app);
  return {
    url: `${baseUrl}/hook`,
    received,
    firstPayload: () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no alarm within 2s")), 2000);
        const settle = () => {
          if (!received.length) return;
          clearTimeout(timer);
          resolve(received[0]!);
        };
        announce = settle;
        settle();
      }),
    close: () => close(server),
  };
};

const alarmTitle = (payload: Record<string, unknown>) =>
  String((payload.embeds as Array<{ title?: string }>)[0]?.title ?? "");

const alarmDetail = (payload: Record<string, unknown>) =>
  String((payload.embeds as Array<{ description?: string }>)[0]?.description ?? "");

describe("errorHandler in the assembled app", () => {
  const originalSecret = process.env.SECRET;

  beforeEach(() => {
    process.env.SECRET = SECRET;
    resetAlarmState();
  });

  afterEach(() => {
    if (originalSecret !== undefined) process.env.SECRET = originalSecret;
    else delete process.env.SECRET;
    // alarm.ts is a no-op without it; the convention this file has to keep is
    // that a `bun test` run never POSTs to whatever `.env` happens to carry.
    delete process.env.DISCORD_ALARM_WEBHOOK;
  });

  const withApp = async (run: (baseUrl: string) => Promise<void>) => {
    const { createHttpApp } = await import("./index");
    const { server, baseUrl } = await listen(createHttpApp(new FaultingStore()));
    try {
      await run(baseUrl);
    } finally {
      await close(server);
    }
  };

  const faultingCookie = { Cookie: `connect.sid=${encodeURIComponent(signCookie("fault-sid"))}` };

  it("answers a store fault on /api/* with JSON on the wire", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/mails`, { headers: faultingCookie });
      const body = await res.text();

      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(body)).toEqual({ status: "error", message: "Internal server error" });
    });
  });

  // finalhandler's answer is text/html; the router's own handler never runs,
  // because express skips a non-arity-4 layer while an error is in flight.
  it("answers a store fault outside /api with plain text, not express's HTML", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`, { headers: faultingCookie });
      const body = await res.text();

      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(body).toBe("Internal server error");
    });
  });

  it("raises the alarm for the store fault", async () => {
    const sink = await startAlarmSink();
    process.env.DISCORD_ALARM_WEBHOOK = sink.url;
    try {
      await withApp(async (baseUrl) => {
        await fetch(`${baseUrl}/api/mails`, { headers: faultingCookie });
        const payload = await sink.firstPayload();

        expect(alarmTitle(payload)).toContain("Unhandled Middleware Error");
        expect(alarmDetail(payload)).toContain("connection terminated unexpectedly");
      });
    } finally {
      await sink.close();
    }
  });

  // Every alarm here shares one cooldown key, so a client error that alarmed
  // would take the bucket and suppress the store fault behind it.
  it("lets a malformed body through as a 400 without spending the alarm", async () => {
    const sink = await startAlarmSink();
    process.env.DISCORD_ALARM_WEBHOOK = sink.url;
    try {
      await withApp(async (baseUrl) => {
        const malformed = await fetch(`${baseUrl}/api/probe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ not json",
        });
        expect(malformed.status).toBe(400);

        await fetch(`${baseUrl}/api/mails`, { headers: faultingCookie });
        const payload = await sink.firstPayload();

        expect(alarmDetail(payload)).toContain("connection terminated unexpectedly");
        expect(sink.received).toHaveLength(1);
      });
    } finally {
      await sink.close();
    }
  });
});
