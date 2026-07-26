import { describe, expect, it, beforeAll, beforeEach, mock, afterAll, spyOn } from "bun:test";
import { restoreLeaves } from "test-helpers";
import crypto from "crypto";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const { postMailgunEventsRoute, resetPool } = await import("server");
const alarmModule = await import("../../alarm");
const sendAlarmSpy = spyOn(alarmModule, "sendAlarm").mockImplementation(async () => {});

// `mock.module` is process-global — a sibling test file that ran earlier
// may have restored `pg` to the real module in its `afterAll(restoreLeaves)`
// AND left the lazy pool cached against the real Pool. Re-assert the pg
// mock and drop the cached pool right before this file's tests, so every
// query below funnels through FakePool. Same pattern users.test.ts uses.
beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  sendAlarmSpy.mockRestore();
  restoreLeaves();
  resetPool();
});

const SIGNING_KEY = "test-signing-key";

const signPayload = (timestamp: string, token: string) =>
  crypto.createHmac("sha256", SIGNING_KEY).update(timestamp + token).digest("hex");

interface FakeReqBody {
  signature?: { timestamp: string; token: string; signature: string };
  "event-data"?: Record<string, unknown>;
}

const call = async (body: FakeReqBody) => {
  const captured: { status?: string; message?: string } = {};
  const res = {
    status(_code: number) {
      return this;
    },
    json(payload: unknown) {
      Object.assign(captured, payload);
      return this;
    },
  };
  await postMailgunEventsRoute.handler(
    { body, method: "POST", url: "/mailgun-events" } as never,
    res as never,
    (() => {}) as never,
  );
  return captured;
};

const nowTs = () => String(Math.floor(Date.now() / 1000));

const buildEvent = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  event: "delivered",
  timestamp: Number(nowTs()),
  recipient: "user@example.com",
  message: { headers: { "message-id": "<abc@hoie.kim>" } },
  ...overrides,
});

const signed = (data: Record<string, unknown>): FakeReqBody => {
  const timestamp = nowTs();
  const token = crypto.randomBytes(16).toString("hex");
  return {
    signature: { timestamp, token, signature: signPayload(timestamp, token) },
    "event-data": data,
  };
};

describe("postMailgunEventsRoute", () => {
  beforeEach(() => {
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = SIGNING_KEY;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    sendAlarmSpy.mockClear();
  });

  it("rejects when the webhook signing key is not configured", async () => {
    delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    const result = await call(signed(buildEvent()));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("not configured");
  });

  it("rejects a body with no signature", async () => {
    const result = await call({ "event-data": buildEvent() });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Invalid signature");
  });

  it("rejects a body with a tampered signature", async () => {
    const body = signed(buildEvent());
    body.signature!.signature = "0".repeat(64);
    const result = await call(body);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Invalid signature");
  });

  it("rejects a body with a stale timestamp (>15 min old)", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 16 * 60);
    const token = "t";
    const result = await call({
      signature: { timestamp: staleTs, token, signature: signPayload(staleTs, token) },
      "event-data": buildEvent(),
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Invalid signature");
  });

  it("rejects a body missing event-data", async () => {
    const timestamp = nowTs();
    const token = "t";
    const result = await call({
      signature: { timestamp, token, signature: signPayload(timestamp, token) },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Malformed");
  });

  it("accepts a signed delivered event and does not alarm", async () => {
    const result = await call(signed(buildEvent({ event: "delivered" })));
    expect(result.status).toBe("success");
    // `delivered` is on the no-alarm allowlist — the classification
    // matters more than the DB call count (which is fragile across
    // sibling test files under Bun's process-global mock.module).
    expect(sendAlarmSpy.mock.calls.length).toBe(0);
  });

  it("alarms on permanent_fail with recipient + reason in the detail", async () => {
    const evt = buildEvent({
      event: "permanent_fail",
      recipient: "target@gmail.com",
      severity: "permanent",
      "delivery-status": {
        code: 550,
        message: "This message is not RFC 5322 compliant.",
      },
    });
    const result = await call(signed(evt));
    expect(result.status).toBe("success");
    expect(sendAlarmSpy.mock.calls.length).toBe(1);
    const [title, detail, key] = sendAlarmSpy.mock.calls[0];
    expect(title).toBe("Mailgun: permanent_fail");
    expect(detail).toContain("target@gmail.com");
    expect(detail).toContain("550");
    expect(detail).toContain("RFC 5322");
    expect(key).toBe("mailgun-permanent_fail");
  });

  it("alarms on `failed` with severity=permanent, and on `complained`", async () => {
    await call(signed(buildEvent({ event: "failed", severity: "permanent" })));
    await call(signed(buildEvent({ event: "complained" })));
    expect(sendAlarmSpy.mock.calls.length).toBe(2);
    expect(sendAlarmSpy.mock.calls[0][0]).toBe("Mailgun: failed");
    expect(sendAlarmSpy.mock.calls[1][0]).toBe("Mailgun: complained");
  });

  it("does NOT alarm on `failed` with severity=temporary (greylist/DNS retry noise)", async () => {
    await call(signed(buildEvent({ event: "failed", severity: "temporary" })));
    expect(sendAlarmSpy.mock.calls.length).toBe(0);
  });

  it("does not alarm on opened/clicked/accepted/unsubscribed", async () => {
    for (const event of ["accepted", "opened", "clicked", "unsubscribed"]) {
      await call(signed(buildEvent({ event })));
    }
    expect(sendAlarmSpy.mock.calls.length).toBe(0);
  });

  it("accepts events with a non-finite timestamp without throwing (attacker-crafted event-data)", async () => {
    // event-data is NOT covered by Mailgun's HMAC — only signature.{timestamp,token}
    // is. An attacker with a captured signature can craft arbitrary event-data
    // within the replay window. `new Date(Infinity * 1000).toISOString()` throws
    // RangeError; safeOccurredAt falls back to `now` instead so the handler
    // returns success and Mailgun doesn't push into hours-long retries.
    const result = await call(
      signed(buildEvent({ event: "delivered", timestamp: Number.POSITIVE_INFINITY })),
    );
    expect(result.status).toBe("success");
  });

  it("returns 200 (success) even when the DB insert throws (Mailgun should not retry)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const result = await call(signed(buildEvent({ event: "delivered" })));
    expect(result.status).toBe("success");
  });
});
