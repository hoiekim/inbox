import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import express from "express";
import type { Server } from "http";

// Mock the alarm module so we can observe calls without touching Discord.
const mockSendAlarm = mock(async () => {});
mock.module("../../alarm", () => ({
  sendAlarm: mockSendAlarm,
}));

let server: Server;
let baseUrl: string;
// alarm.test.ts (and possibly others) overrides global.fetch. We need the
// real fetch to drive HTTP into our listening server.
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // Re-import after mocks are in place so the router picks up mockSendAlarm.
  const clientErrorRouter = (await import("./client-error")).default;

  const app = express();
  app.use(express.json());
  app.use("/api/client-error", clientErrorRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  mockSendAlarm.mockClear();
});

const postClientError = async (ip: string, body: object = { message: "x" }) => {
  if (!baseUrl) throw new Error(`baseUrl not set (server start failed)`);
  return realFetch(`${baseUrl}/api/client-error`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": ip,
    },
    body: JSON.stringify(body),
  });
};

describe("POST /api/client-error rate limiting (issue #517)", () => {
  it("returns 429 after the per-IP cap is exceeded", async () => {
    const ip = "203.0.113.1"; // RFC 5737 TEST-NET-3, unique per test
    for (let i = 0; i < 5; i++) {
      const res = await postClientError(ip);
      expect(res.status).toBe(200);
    }
    const blocked = await postClientError(ip);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { status: string; message: string };
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/too many/i);
  });

  it("isolates the IP cap — other IPs can still report", async () => {
    const ipA = "203.0.113.2";
    const ipB = "203.0.113.3";
    // Burn ipA's budget.
    for (let i = 0; i < 6; i++) await postClientError(ipA);
    // ipB should still get through.
    const res = await postClientError(ipB);
    expect(res.status).toBe(200);
  });

  it("forwards to sendAlarm with the dedicated 'client-error' cooldown key", async () => {
    const res = await postClientError("203.0.113.4", {
      message: "boom",
      stack: "at thing",
      url: "https://example.com/x",
    });
    expect(res.status).toBe(200);
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    const args = mockSendAlarm.mock.calls[0] as [string, string, string];
    expect(args[0]).toBe("Client JS Error");
    expect(args[2]).toBe("client-error");
  });
});

describe("POST /api/client-error location enrichment (issue #631)", () => {
  it("surfaces filename:lineno:colno so opaque 'Script error.' reports are actionable", async () => {
    const res = await postClientError("203.0.113.10", {
      message: "Script error.",
      url: "https://mail.hoie.kim/",
      filename: "chrome-extension://abcdef/inject.js",
      lineno: 42,
      colno: 7,
    });
    expect(res.status).toBe(200);
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    const detail = mockSendAlarm.mock.calls[0][1] as string;
    expect(detail).toContain("chrome-extension://abcdef/inject.js:42:7");
    expect(detail).toContain("Script error.");
  });

  it("omits the Source line when no location is provided", async () => {
    const res = await postClientError("203.0.113.11", {
      message: "boom",
      url: "https://mail.hoie.kim/",
    });
    expect(res.status).toBe(200);
    const detail = mockSendAlarm.mock.calls[0][1] as string;
    expect(detail).not.toContain("**Source:**");
  });

  it("tolerates a filename without line/column numbers", async () => {
    const res = await postClientError("203.0.113.12", {
      message: "Script error.",
      filename: "https://cdn.example.com/vendor.js",
    });
    expect(res.status).toBe(200);
    const detail = mockSendAlarm.mock.calls[0][1] as string;
    expect(detail).toContain("**Source:** https://cdn.example.com/vendor.js");
  });
});
