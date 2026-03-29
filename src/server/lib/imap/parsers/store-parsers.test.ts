import { describe, it, expect } from "bun:test";
import { parseStore, parseCopy } from "./store-parsers";
import { ParseContext } from "../types";

function ctx(input: string, position = 0): ParseContext {
  return { input, position, length: input.length };
}

// ─── parseStore ───────────────────────────────────────────────────────────────

describe("parseStore", () => {
  it("parses FLAGS with a single flag", () => {
    const c = ctx("1 FLAGS (\\Seen)");
    const r = parseStore(c);
    expect(r.success).toBe(true);
    expect(r.value!.type).toBe("STORE");
    expect(r.value!.data.operation).toBe("FLAGS");
    expect(r.value!.data.flags).toEqual(["\\Seen"]);
    expect(r.value!.data.silent).toBe(false);
  });

  it("parses +FLAGS.SILENT with multiple flags", () => {
    const c = ctx("1:5 +FLAGS.SILENT (\\Seen \\Flagged)");
    const r = parseStore(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.operation).toBe("+FLAGS.SILENT");
    expect(r.value!.data.flags).toEqual(["\\Seen", "\\Flagged"]);
    expect(r.value!.data.silent).toBe(true);
    expect(r.value!.data.sequenceSet.ranges[0]).toEqual({ start: 1, end: 5 });
  });

  it("parses -FLAGS with a single flag (no parens)", () => {
    const c = ctx("2 -FLAGS \\Deleted");
    const r = parseStore(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.operation).toBe("-FLAGS");
    expect(r.value!.data.flags).toEqual(["\\Deleted"]);
  });

  it("parses FLAGS.SILENT", () => {
    const c = ctx("3 FLAGS.SILENT (\\Answered)");
    const r = parseStore(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.operation).toBe("FLAGS.SILENT");
    expect(r.value!.data.silent).toBe(true);
  });

  it("parses -FLAGS.SILENT", () => {
    const c = ctx("1 -FLAGS.SILENT (\\Seen)");
    const r = parseStore(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.silent).toBe(true);
  });

  it("parses empty flags list", () => {
    const c = ctx("1 FLAGS ()");
    const r = parseStore(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.flags).toEqual([]);
  });

  it("fails on invalid sequence set", () => {
    const c = ctx("abc FLAGS (\\Seen)");
    const r = parseStore(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("sequence set");
  });

  it("fails on invalid item name", () => {
    const c = ctx("1 BADOP (\\Seen)");
    const r = parseStore(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Invalid store operation");
  });

  it("fails on missing item name", () => {
    const c = ctx("1 ");
    const r = parseStore(c);
    expect(r.success).toBe(false);
  });

  it("fails when flag is missing in parenthesized list", () => {
    // non-flag character inside parens
    const c = ctx("1 FLAGS ({)");
    const r = parseStore(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Invalid flag");
  });
});

// ─── parseCopy ────────────────────────────────────────────────────────────────

describe("parseCopy", () => {
  it("parses a simple COPY command", () => {
    const c = ctx("1 INBOX");
    const r = parseCopy(c);
    expect(r.success).toBe(true);
    expect(r.value!.type).toBe("COPY");
    expect(r.value!.data.mailbox).toBe("INBOX");
    expect(r.value!.data.sequenceSet.ranges[0]).toEqual({ start: 1 });
  });

  it("parses a range COPY", () => {
    const c = ctx("1:10 Trash");
    const r = parseCopy(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.sequenceSet.ranges[0]).toEqual({ start: 1, end: 10 });
    expect(r.value!.data.mailbox).toBe("Trash");
  });

  it("parses COPY with quoted mailbox name", () => {
    const c = ctx('1 "My Mailbox"');
    const r = parseCopy(c);
    expect(r.success).toBe(true);
    expect(r.value!.data.mailbox).toBe("My Mailbox");
  });

  it("fails on invalid sequence set", () => {
    const c = ctx("abc INBOX");
    const r = parseCopy(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("sequence set");
  });

  it("fails on missing mailbox name", () => {
    const c = ctx("1 ");
    const r = parseCopy(c);
    expect(r.success).toBe(false);
    expect(r.error).toContain("mailbox");
  });
});
