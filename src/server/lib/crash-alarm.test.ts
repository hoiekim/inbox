import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import * as alarm from "./alarm";
import {
  alarmThenExit,
  deliverCrashAlarm,
  formatCrashDetail,
  CRASH_ALARM_TIMEOUT_MS,
} from "./crash-alarm";

describe("formatCrashDetail", () => {
  it("renders an Error's message and stack", () => {
    const error = new Error("pool connect ECONNREFUSED");
    const detail = formatCrashDetail(error);
    expect(detail).toContain("**Message:** pool connect ECONNREFUSED");
    expect(detail).toContain(error.stack!.slice(0, 40));
  });

  it("stringifies a non-Error value and emits an empty stack block", () => {
    expect(formatCrashDetail("plain string reason")).toBe(
      "**Message:** plain string reason\n```\n\n```",
    );
  });

  it("truncates the stack at 1000 characters", () => {
    const error = new Error("long");
    error.stack = "x".repeat(5_000);
    const detail = formatCrashDetail(error);
    expect(detail).toBe(`**Message:** long\n\`\`\`\n${"x".repeat(1000)}\n\`\`\``);
  });
});

describe("deliverCrashAlarm", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it("waits for a slow webhook to finish before resolving", async () => {
    // The regression this module exists to prevent: the old
    // uncaughtException handler fired sendAlarm without awaiting, so
    // process.exit ran while the POST was still in flight. Assert the
    // send has actually SETTLED by the time we hand control back.
    let settled = false;
    const sendSpy = spyOn(alarm, "sendAlarm").mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 200),
        ),
    );
    await deliverCrashAlarm("Uncaught Exception", new Error("boom"));
    expect(settled).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [title, detail] = sendSpy.mock.calls[0]!;
    expect(title).toBe("Uncaught Exception");
    expect(detail).toContain("boom");
    sendSpy.mockRestore();
  });

  it("resolves instead of rejecting when the webhook errors", async () => {
    const sendSpy = spyOn(alarm, "sendAlarm").mockRejectedValue(
      new Error("webhook 500"),
    );
    expect(await deliverCrashAlarm("Uncaught Exception", new Error("boom"))).toBe(
      undefined,
    );
    sendSpy.mockRestore();
  });

  it("gives up on a hung webhook at CRASH_ALARM_TIMEOUT_MS", async () => {
    const sendSpy = spyOn(alarm, "sendAlarm").mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const started = Date.now();
    await deliverCrashAlarm("Uncaught Exception", new Error("hang"));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(CRASH_ALARM_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(CRASH_ALARM_TIMEOUT_MS + 2_000);
    sendSpy.mockRestore();
  }, 10_000);
});

describe("alarmThenExit", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("__test_process_exit__");
    }) as never);
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("exits 1 only after the alarm has settled", async () => {
    let settled = false;
    const sendSpy = spyOn(alarm, "sendAlarm").mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 200),
        ),
    );
    try {
      await alarmThenExit("Startup Failed", new Error("boom"));
    } catch (e) {
      if ((e as Error).message !== "__test_process_exit__") throw e;
    }
    expect(settled).toBe(true);
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);
    sendSpy.mockRestore();
  });
});
