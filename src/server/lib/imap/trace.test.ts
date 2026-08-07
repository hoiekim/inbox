import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "server";

const importTrace = async () => {
  delete require.cache[require.resolve("./trace")];
  return await import("./trace");
};

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
    const { imapTrace } = await importTrace();
    imapTrace("in", "session_abc", "A1 NOOP");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("emits one info per non-empty CRLF-split inbound line when IMAP_TRACE=1", async () => {
    process.env.IMAP_TRACE = "1";
    const { imapTrace } = await importTrace();
    infoSpy.mockClear(); // ignore the load-time enable-notice
    imapTrace("in", "session_abc", "A1 NOOP\r\nA2 CAPABILITY\r\n");
    expect(infoSpy).toHaveBeenCalledTimes(2);
    const lines = infoSpy.mock.calls.map((c) => (c[1] as { line: string }).line);
    expect(lines).toEqual(["A1 NOOP", "A2 CAPABILITY"]);
  });

  it("redacts LOGIN password on inbound", async () => {
    process.env.IMAP_TRACE = "1";
    const { imapTrace } = await importTrace();
    infoSpy.mockClear();
    imapTrace("in", "session_abc", 'A1 LOGIN "admin" "hunter2"');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = (infoSpy.mock.calls[0][1] as { line: string }).line;
    expect(line).toBe("A1 LOGIN [REDACTED]");
    expect(line).not.toContain("hunter2");
  });

  it("redacts AUTHENTICATE initial response on inbound (RFC 4959)", async () => {
    process.env.IMAP_TRACE = "1";
    const { imapTrace } = await importTrace();
    infoSpy.mockClear();
    imapTrace("in", "session_abc", "A2 AUTHENTICATE PLAIN AGFkbWluAGh1bnRlcjI=");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = (infoSpy.mock.calls[0][1] as { line: string }).line;
    expect(line).toBe("A2 AUTHENTICATE PLAIN [REDACTED]");
    expect(line).not.toContain("AGFkbWlu");
  });

  it("emits outbound framing lines that match the allowlist", async () => {
    process.env.IMAP_TRACE = "1";
    const { imapTrace } = await importTrace();
    infoSpy.mockClear();
    imapTrace(
      "out",
      "session_abc",
      [
        "* OK IMAP4rev1 Service Ready",
        "* CAPABILITY IMAP4rev1 LITERAL+",
        "* 12 EXISTS",
        "* 0 RECENT",
        "* BYE Server logging out",
        "+ go ahead",
        "A1 OK LOGIN completed",
        "A2 NO Not authenticated.",
        "A3 BAD Invalid syntax",
      ].join("\r\n")
    );
    expect(infoSpy).toHaveBeenCalledTimes(9);
  });

  it("drops untagged FETCH data + literal payload + ENVELOPE content", async () => {
    process.env.IMAP_TRACE = "1";
    const { imapTrace } = await importTrace();
    infoSpy.mockClear();
    imapTrace(
      "out",
      "session_abc",
      [
        "* 5 FETCH (UID 100 RFC822.SIZE 19222751 FLAGS (\\Seen))",
        "Subject: Attorney client privileged — do not disclose",
        "From: someone@example.com",
        'ENVELOPE ("Wed" "hello" ((NIL NIL "alice" "ex.com")) …)',
        ")",
      ].join("\r\n")
    );
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("clips lines longer than the cap and marks the overflow", async () => {
    process.env.IMAP_TRACE = "1";
    const { imapTrace } = await importTrace();
    infoSpy.mockClear();
    const filler = "X".repeat(600);
    imapTrace("in", "session_abc", `A1 SELECT ${filler}`);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = (infoSpy.mock.calls[0][1] as { line: string }).line;
    expect(line.length).toBeLessThan(600 + "A1 SELECT ".length);
    expect(line).toMatch(/…\[\+\d+\]$/);
  });

  it("emits a one-time enable notice at module load when IMAP_TRACE=1", async () => {
    process.env.IMAP_TRACE = "1";
    await importTrace();
    const enableCall = infoSpy.mock.calls.find(
      (c) => (c[0] as string).includes("IMAP wire trace ENABLED")
    );
    expect(enableCall).toBeDefined();
  });
});
