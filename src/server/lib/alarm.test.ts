import { describe, it, expect, beforeAll, beforeEach, mock, afterEach, afterAll } from "bun:test";

// Mock fetch only during this file's tests so we don't pollute global state
// for other test files (e.g. client-error.test.ts opens a real listening
// server and uses fetch to drive it).
const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
const realFetch = globalThis.fetch;

let alarm: typeof import("./alarm");

beforeAll(() => {
  globalThis.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  mockFetch.mockClear();
  alarm = await import("./alarm");
  alarm.resetAlarmState();
});

afterEach(() => {
  delete process.env.DISCORD_ALARM_WEBHOOK;
});

describe("sendAlarm", () => {
  it("does nothing when DISCORD_ALARM_WEBHOOK is not set", async () => {
    delete process.env.DISCORD_ALARM_WEBHOOK;
    await alarm.sendAlarm("Test", "detail");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends a POST to the webhook URL", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Test Error", "Something went wrong");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/test");
    expect(options.method).toBe("POST");
  });

  it("respects cooldown — second alarm within 60s on the same key is suppressed", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Same Title", "detail 1");
    await alarm.sendAlarm("Same Title", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("isolates cooldowns by key — different keys do not suppress each other", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    // Simulates the issue #517 scenario: a flood of client-error alarms must
    // not suppress unrelated server-side alarms.
    await alarm.sendAlarm("Client JS Error", "detail", "client-error");
    await alarm.sendAlarm("Unhandled Promise Rejection", "detail");
    await alarm.sendAlarm("Uncaught Exception", "detail");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("explicit key uses its own bucket even when title differs", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    // Two calls into the same explicit key bucket → second is suppressed even
    // though titles differ.
    await alarm.sendAlarm("First Title", "detail", "shared-bucket");
    await alarm.sendAlarm("Second Title", "detail", "shared-bucket");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
