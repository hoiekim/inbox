/**
 * describeImapCommand — per-command summary that feeds the "IMAP command
 * completed" diagnostic log. Load-bearing invariants:
 *   1. Never emits the LOGIN password.
 *   2. Summary is bounded (< 200 chars) so a pathological input can't blow log volume.
 *   3. Sequence ranges + item lists are preserved for the OOM-suspect commands
 *      (FETCH/STORE/COPY/MOVE/UID) — they're what identify a full-mailbox
 *      fan-out that would trigger a memory spike.
 */
import { describe, it, expect } from "bun:test";
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

  it("summary is capped so a pathological input can't blow log volume", () => {
    // SEARCH criteria can be arbitrarily nested; force a huge input.
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

  it("unknown / bare-tag types fall through to the type token (never throws)", () => {
    expect(describeImapCommand({ type: "NOOP" } as ImapRequest)).toBe("NOOP");
    expect(describeImapCommand({ type: "CAPABILITY" } as ImapRequest)).toBe("CAPABILITY");
    expect(describeImapCommand({ type: "LOGOUT" } as ImapRequest)).toBe("LOGOUT");
    expect(describeImapCommand({ type: "IDLE" } as ImapRequest)).toBe("IDLE");
  });
});
