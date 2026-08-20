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
  boundCrashStep,
  claimCrashSequence,
  deliverCrashAlarm,
  formatCrashDetail,
  resetCrashSequence,
  CRASH_ALARM_TIMEOUT_MS,
} from "./crash-alarm";

// Read via `Bun.file(...).text()` NOT `fs.readFileSync`: sibling test files
// do `mock.module("fs", ...)`, which is process-global in Bun and can replace
// the export under some full-suite orderings.
const START_TS = await Bun.file(
  new URL("../start.ts", import.meta.url),
).text();

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
    // Assert the send has actually SETTLED by the time we hand control back.
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

  it("resolves instead of rejecting when sendAlarm rejects", async () => {
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
    resetCrashSequence();
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

describe("claimCrashSequence", () => {
  afterEach(() => resetCrashSequence());

  it("grants the sequence to the first caller only", () => {
    expect(claimCrashSequence()).toBe(true);
    expect(claimCrashSequence()).toBe(false);
    expect(claimCrashSequence()).toBe(false);
  });

  it("lets the first fault's delivery settle while a second fault is dropped", async () => {
    let delivered = false;
    const sendSpy = spyOn(alarm, "sendAlarm").mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            delivered = true;
            resolve();
          }, 200),
        ),
    );
    const handle = async (error: unknown): Promise<"exited" | "dropped"> => {
      if (!claimCrashSequence()) return "dropped";
      await deliverCrashAlarm("Uncaught Exception", error);
      return "exited";
    };
    const [first, second] = await Promise.all([
      handle(new Error("fault A")),
      handle(new Error("fault B")),
    ]);
    expect(first).toBe("exited");
    expect(second).toBe("dropped");
    expect(delivered).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });
});

describe("uncaughtException handler wiring", () => {
  it("awaits the crash-alarm delivery before exiting", () => {
    expect(
      /await deliverCrashAlarm\(\s*"Uncaught Exception"/.test(START_TS),
    ).toBe(true);
  });

  it("drops a re-entrant fault instead of racing the in-flight delivery", () => {
    expect(/if \(!claimCrashSequence\(\)\)\s*\{?\s*return/.test(START_TS)).toBe(
      true,
    );
  });

  it("bounds the pool drain so a wedged pool cannot swallow the exit", () => {
    expect(
      /await boundCrashStep\(\s*pool\.end\(\),\s*POOL_SHUTDOWN_TIMEOUT_MS/.test(
        START_TS,
      ),
    ).toBe(true);
  });
});

describe("alarmThenExit — crash sequence handoff", () => {
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
    resetCrashSequence();
  });

  it("neither alarms nor exits when another fault already owns the sequence", async () => {
    const sendSpy = spyOn(alarm, "sendAlarm").mockResolvedValue(undefined);
    claimCrashSequence();
    let handedOff = true;
    void alarmThenExit("Startup Failed", new Error("boom")).then(
      () => (handedOff = false),
      () => (handedOff = false),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handedOff).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });
});

describe("boundCrashStep", () => {
  it("gives up on a step that never settles", async () => {
    const started = Date.now();
    await boundCrashStep(new Promise(() => undefined), 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("swallows a rejecting step instead of propagating it", async () => {
    expect(
      await boundCrashStep(Promise.reject(new Error("pool wedged")), 1_000),
    ).toBe(undefined);
  });

  it("returns as soon as the step settles", async () => {
    const started = Date.now();
    await boundCrashStep(Promise.resolve(), 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
