/**
 * describeImapCommand — per-command summary that feeds the "IMAP command
 * completed" diagnostic log. Load-bearing invariants:
 *   1. Never emits the LOGIN password.
 *   2. Summary is bounded (< 200 chars) so a pathological input can't blow log volume.
 *   3. Sequence ranges + item lists are preserved for the OOM-suspect commands
 *      (FETCH/STORE/COPY/MOVE/UID) — they're what identify a full-mailbox
 *      fan-out that would trigger a memory spike.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { describeImapCommand } from "./handler";
import type { ImapRequest } from "./types";

describe("describeImapCommand", () => {
  it("redacts LOGIN password (only username survives)", () => {
    const req: ImapRequest = {
      type: "LOGIN",
      data: { username: "admin", password: "super-secret-do-not-log" },
    };
    const out = describeImapCommand(req);
    expect(out).toBe("LOGIN admin");
    expect(out).not.toContain("super-secret");
  });

  it("FETCH includes sequence range and item types (no bodies)", () => {
    const req: ImapRequest = {
      type: "FETCH",
      data: {
        sequenceSet: { type: "sequence", ranges: [{ start: 1, end: 100 }] },
        dataItems: [{ type: "UID" }, { type: "FLAGS" }, { type: "ENVELOPE" }],
      },
    } as ImapRequest;
    expect(describeImapCommand(req)).toBe("FETCH 1:100 (UID FLAGS ENVELOPE)");
  });

  it("UID FETCH prefixes the inner FETCH summary", () => {
    const req: ImapRequest = {
      type: "UID",
      data: {
        command: "FETCH",
        request: {
          type: "FETCH",
          data: {
            sequenceSet: { type: "uid", ranges: [{ start: 1, end: 999999 }] },
            dataItems: [{ type: "UID" }, { type: "FLAGS" }],
          },
        } as ImapRequest,
      },
    };
    expect(describeImapCommand(req)).toBe("UID FETCH 1:999999 (UID FLAGS)");
  });

  it("SELECT/STATUS/LIST preserve the mailbox path (visible in logs is fine)", () => {
    expect(
      describeImapCommand({ type: "SELECT", data: { mailbox: "INBOX" } } as ImapRequest)
    ).toBe("SELECT INBOX");
    expect(
      describeImapCommand({
        type: "STATUS",
        data: { mailbox: "INBOX/accounts/claude", items: ["MESSAGES", "UIDNEXT"] },
      } as ImapRequest)
    ).toBe("STATUS INBOX/accounts/claude (MESSAGES UIDNEXT)");
    expect(
      describeImapCommand({
        type: "LIST",
        data: { reference: "", pattern: "*" },
      } as ImapRequest)
    ).toBe('LIST "" "*"');
  });

  it("STORE captures range + operation + flags (needed to spot bulk flag mutations)", () => {
    const req: ImapRequest = {
      type: "STORE",
      data: {
        sequenceSet: { type: "sequence", ranges: [{ start: 1, end: 500 }] },
        operation: "+FLAGS",
        flags: ["\\Seen"],
      },
    } as ImapRequest;
    expect(describeImapCommand(req)).toBe("STORE 1:500 +FLAGS \\Seen");
  });

  it("APPEND reports the message size (identifies giant uploads without leaking body)", () => {
    const req: ImapRequest = {
      type: "APPEND",
      data: { mailbox: "Drafts", message: "a".repeat(4096) },
    } as ImapRequest;
    expect(describeImapCommand(req)).toBe("APPEND Drafts 4096B");
  });

  it("summary is capped so a pathological input can't blow log volume — SEARCH", () => {
    const req: ImapRequest = {
      type: "SEARCH",
      data: {
        criteria: { type: "TEXT", value: "x".repeat(10_000) },
      },
    } as ImapRequest;
    const out = describeImapCommand(req);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.startsWith("SEARCH")).toBe(true);
  });

  // The 200-char cap must apply to EVERY branch. Earlier revisions applied
  // `summary(...)` only to FETCH/STORE/SEARCH/COPY/MOVE, so a long mailbox
  // path, LOGIN username, LIST pattern, or ENABLE capability list bypassed
  // the cap silently. This locks in coverage across the branches that can
  // take user-controlled strings of arbitrary length.
  it.each([
    ["LOGIN long username", { type: "LOGIN", data: { username: "u".repeat(10_000), password: "p" } }],
    ["SELECT long mailbox", { type: "SELECT", data: { mailbox: "m".repeat(10_000) } }],
    ["EXAMINE long mailbox", { type: "EXAMINE", data: { mailbox: "m".repeat(10_000) } }],
    ["LIST long pattern", { type: "LIST", data: { reference: "", pattern: "*".repeat(10_000) } }],
    ["LSUB long pattern", { type: "LSUB", data: { reference: "", pattern: "*".repeat(10_000) } }],
    ["STATUS long mailbox", { type: "STATUS", data: { mailbox: "m".repeat(10_000), items: ["UIDNEXT"] } }],
    ["APPEND long mailbox", { type: "APPEND", data: { mailbox: "m".repeat(10_000), message: "" } }],
    ["CREATE long mailbox", { type: "CREATE", data: { mailbox: "m".repeat(10_000) } }],
    ["ENABLE long capability list", { type: "ENABLE", data: { capabilities: ["CAP".repeat(5000)] } }],
    ["AUTHENTICATE long mechanism", { type: "AUTHENTICATE", data: { mechanism: "X".repeat(10_000) } }],
  ])("caps %s at 200 chars", (_label, req) => {
    const out = describeImapCommand(req as ImapRequest);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("unknown / bare-tag types fall through to the type token (never throws)", () => {
    expect(describeImapCommand({ type: "NOOP" } as ImapRequest)).toBe("NOOP");
    expect(describeImapCommand({ type: "CAPABILITY" } as ImapRequest)).toBe("CAPABILITY");
    expect(describeImapCommand({ type: "LOGOUT" } as ImapRequest)).toBe("LOGOUT");
    expect(describeImapCommand({ type: "IDLE" } as ImapRequest)).toBe("IDLE");
  });
});

/**
 * The per-command diagnostic log line downgrades to `logger.debug` for
 * "noise-floor" commands (zero RSS delta AND sub-INTERESTING-duration AND
 * sub-INTERESTING-response-bytes). Prod's INFO-level filter suppresses
 * DEBUG, so a client retry storm no longer drowns journald's tail cap.
 *
 * Guarded via source-scan because a real invocation would need the full
 * ImapRequestHandler + a mock session + fake socket + inserted stdout
 * capture; that's outside the leaf-test setup we have. Source-scan is
 * durable against silent regression when future edits reshape the
 * finally-block (which is exactly where this gate lives).
 */
describe("per-command diag log — threshold gate (2026-07-28 log-volume)", () => {
  let handlerSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    handlerSource = await fs.readFile(
      path.join(import.meta.dir, "handler.ts"),
      "utf8"
    );
  });

  it("declares the three interesting-threshold constants at module scope", () => {
    // Interesting commands log at INFO. Thresholds are named constants
    // so a future tuning PR touches one place rather than a magic-number
    // expression inside the finally block.
    expect(handlerSource).toMatch(/const INTERESTING_RSS_DELTA_MB\s*=\s*\d+/);
    expect(handlerSource).toMatch(/const INTERESTING_DURATION_MS\s*=\s*\d+/);
    expect(handlerSource).toMatch(/const INTERESTING_RESPONSE_BYTES\s*=\s*\d+/);
  });

  it("gates the per-command log via OR of the three thresholds", () => {
    // OR (not AND): any single interesting axis is enough to keep the
    // line at INFO. `UID FETCH X (BODY)` on a 2 MB message: big response
    // OR big RSS delta OR slow duration — all three usually true, so
    // it's kept. `UID FETCH X (FLAGS)` on an idle poll: none, drops to
    // DEBUG.
    expect(handlerSource).toMatch(
      /Math\.abs\(rssDeltaMB\)\s*>=\s*INTERESTING_RSS_DELTA_MB/
    );
    expect(handlerSource).toMatch(
      /durationMs\s*>=\s*INTERESTING_DURATION_MS/
    );
    expect(handlerSource).toMatch(
      /responseBytes\s*>=\s*INTERESTING_RESPONSE_BYTES/
    );
  });

  it("routes interesting commands to logger.info and noise-floor to logger.debug", () => {
    // The finally block used to unconditionally `logger.info`. The gate
    // splits into info+debug — the DEBUG branch is what prod's INFO
    // filter drops.
    expect(handlerSource).toMatch(
      /if\s*\(isInteresting\)\s*\{\s*logger\.info\("IMAP command completed", payload\);/
    );
    expect(handlerSource).toMatch(
      /else\s*\{\s*logger\.debug\("IMAP command completed", payload\);/
    );
  });

  it("keeps the payload shape identical across INFO and DEBUG paths (no drift under storm)", () => {
    // Triage debugging a storm should be able to raise the log level to
    // DEBUG once and get the SAME fields it sees at INFO — no missing
    // `remote`, `rssDeltaMB`, `responseBytes`. Guard by asserting the
    // payload literal is declared once and both branches reference it.
    expect(handlerSource).toMatch(/const payload = \{/);
    // Both `logger.info` and `logger.debug` should pass `payload`, not
    // an inline object literal each.
    const infoUses =
      (handlerSource.match(/logger\.info\("IMAP command completed", payload\)/g) ??
        [])
        .length;
    const debugUses =
      (handlerSource.match(/logger\.debug\("IMAP command completed", payload\)/g) ??
        [])
        .length;
    expect(infoUses).toBe(1);
    expect(debugUses).toBe(1);
  });
});
