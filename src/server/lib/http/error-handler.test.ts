import { describe, it, expect, mock, afterEach } from "bun:test";

import type { Request, Response } from "express";

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

describe("errorHandler", () => {
  it("answers /api/* with a 500 JSON error body", async () => {
    const { errorHandler } = await import("./error-handler");
    const res = makeRes();
    const next = mock(() => {});

    errorHandler(new Error("connection terminated unexpectedly"), makeReq("/api/mails"), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res._body).toEqual({
      status: "error",
      message: "connection terminated unexpectedly",
    });
    expect(next).not.toHaveBeenCalled();
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
});
