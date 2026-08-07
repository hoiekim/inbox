import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "server";

describe("imapTrace", () => {
  const originalTrace = process.env.IMAP_TRACE;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(logger, "info");
  });
  afterEach(() => {
    infoSpy.mockRestore();
    if (originalTrace === undefined) delete process.env.IMAP_TRACE;
    else process.env.IMAP_TRACE = originalTrace;
  });

  it("is a no-op when IMAP_TRACE is not set", async () => {
    delete process.env.IMAP_TRACE;
    delete require.cache[require.resolve("./trace")];
    const { imapTrace } = await import("./trace");
    imapTrace("in", "session_abc", "A1 NOOP");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("emits one info per non-empty CRLF-split line when IMAP_TRACE=1", async () => {
    process.env.IMAP_TRACE = "1";
    delete require.cache[require.resolve("./trace")];
    const { imapTrace } = await import("./trace");
    imapTrace("out", "session_abc", "* 5 EXISTS\r\n* 5 RECENT\r\nA1 OK NOOP completed\r\n");
    expect(infoSpy).toHaveBeenCalledTimes(3);
    const lines = infoSpy.mock.calls.map((c) => (c[1] as { line: string }).line);
    expect(lines).toEqual([
      "* 5 EXISTS",
      "* 5 RECENT",
      "A1 OK NOOP completed",
    ]);
  });

  it("clips lines longer than the cap and marks the overflow", async () => {
    process.env.IMAP_TRACE = "1";
    delete require.cache[require.resolve("./trace")];
    const { imapTrace } = await import("./trace");
    const long = "X".repeat(250);
    imapTrace("out", "session_abc", long);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = (infoSpy.mock.calls[0][1] as { line: string }).line;
    expect(line.length).toBeLessThan(long.length);
    expect(line.endsWith("…[+50]")).toBe(true);
  });
});
