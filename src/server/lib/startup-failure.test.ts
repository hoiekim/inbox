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
  handleStartupFailure,
  STARTUP_ALARM_TIMEOUT_MS,
} from "./startup-failure";

describe("handleStartupFailure", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Swallow the exit so the test process doesn't die; throw a tagged
    // sentinel so the awaited handler unwinds after the exit call.
    exitSpy = spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("__test_process_exit__");
    }) as never);
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const runHandler = async (error: unknown): Promise<number | undefined> => {
    try {
      await handleStartupFailure(error);
    } catch (e) {
      if ((e as Error).message !== "__test_process_exit__") throw e;
    }
    return exitSpy.mock.calls[0]?.[0] as number | undefined;
  };

  it("exits with code 1 after the alarm delivers", async () => {
    const sendSpy = spyOn(alarm, "sendAlarm").mockResolvedValue(undefined);
    const code = await runHandler(new Error("initializePostgres timed out"));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [title, detail] = sendSpy.mock.calls[0]!;
    expect(title).toBe("Startup Failed");
    expect(detail).toContain("initializePostgres timed out");
    expect(code).toBe(1);
    sendSpy.mockRestore();
  });

  it("still exits when the alarm rejects — never blocks the crash path", async () => {
    const sendSpy = spyOn(alarm, "sendAlarm").mockRejectedValue(
      new Error("webhook 500"),
    );
    const code = await runHandler(new Error("boom"));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
    sendSpy.mockRestore();
  });

  it("bounds wait on a hung alarm at STARTUP_ALARM_TIMEOUT_MS + exits anyway", async () => {
    // Never resolves — simulates a fetch stuck against a slow/down webhook.
    const sendSpy = spyOn(alarm, "sendAlarm").mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const started = Date.now();
    const code = await runHandler(new Error("hang test"));
    const elapsed = Date.now() - started;
    expect(code).toBe(1);
    // Give a generous ceiling (CI jitter) — the point is we DID exit, not
    // that we exited at exactly the timeout.
    expect(elapsed).toBeGreaterThanOrEqual(STARTUP_ALARM_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(STARTUP_ALARM_TIMEOUT_MS + 2_000);
    sendSpy.mockRestore();
  }, 10_000);

  it("stringifies a non-Error rejection value into the alarm message", async () => {
    const sendSpy = spyOn(alarm, "sendAlarm").mockResolvedValue(undefined);
    await runHandler("plain string reason");
    const [, detail] = sendSpy.mock.calls[0]!;
    expect(detail).toContain("plain string reason");
    sendSpy.mockRestore();
  });
});
