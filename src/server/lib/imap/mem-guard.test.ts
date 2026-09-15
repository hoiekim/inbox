/**
 * RSS soft-guard predicate + BODY[] classifier + trace-line formatter.
 *
 * These are pure — the socket-level integration (tagged NO + close on a real
 * ImapSession) is not covered here because a session harness would just
 * inflate the fixture; the surface being defended is the predicate and the
 * env-var read, and both are exercised directly.
 *
 * Mutation discipline: every threshold-comparison assertion below is
 * accompanied by a fixture that FLIPS its outcome when the threshold moves,
 * so a hard-coded 200 MiB in the implementation would fail the mutation.
 */

import { describe, it, expect, afterEach } from "bun:test";

import {
  DEFAULT_RSS_SOFT_LIMIT_MB,
  fetchNeedsMemoryGuard,
  formatMemTraceLine,
  getRssSoftLimitBytes,
  isImapMemTraceEnabled,
  isOverRssSoftLimit,
} from "./mem-guard";
import { FetchDataItem } from "./types";

const MB = 1024 * 1024;

const envKeys = ["IMAP_RSS_SOFT_LIMIT_MB", "IMAP_MEM_TRACE"];

afterEach(() => {
  for (const k of envKeys) delete process.env[k];
});

// ---------------------------------------------------------------------------
// getRssSoftLimitBytes
// ---------------------------------------------------------------------------

describe("getRssSoftLimitBytes", () => {
  it("defaults to 200 MiB when the env var is unset", () => {
    expect(getRssSoftLimitBytes()).toBe(DEFAULT_RSS_SOFT_LIMIT_MB * MB);
    expect(DEFAULT_RSS_SOFT_LIMIT_MB).toBe(200);
  });

  it("honors a valid positive integer", () => {
    process.env.IMAP_RSS_SOFT_LIMIT_MB = "300";
    expect(getRssSoftLimitBytes()).toBe(300 * MB);
  });

  it("falls back to default on non-numeric, zero, or negative values", () => {
    for (const bad of ["", "abc", "0", "-50"]) {
      process.env.IMAP_RSS_SOFT_LIMIT_MB = bad;
      expect(getRssSoftLimitBytes()).toBe(DEFAULT_RSS_SOFT_LIMIT_MB * MB);
    }
  });

  it("reads env on every call (not module-load-time)", () => {
    process.env.IMAP_RSS_SOFT_LIMIT_MB = "150";
    expect(getRssSoftLimitBytes()).toBe(150 * MB);
    process.env.IMAP_RSS_SOFT_LIMIT_MB = "250";
    expect(getRssSoftLimitBytes()).toBe(250 * MB);
  });
});

// ---------------------------------------------------------------------------
// isOverRssSoftLimit — the guard predicate
// ---------------------------------------------------------------------------

describe("isOverRssSoftLimit", () => {
  it("returns true when RSS >= threshold (guard fires)", () => {
    expect(isOverRssSoftLimit(210 * MB, 200 * MB)).toBe(true);
    // Boundary: at the threshold itself is a breach.
    expect(isOverRssSoftLimit(200 * MB, 200 * MB)).toBe(true);
  });

  it("returns false when RSS < threshold (guard silent)", () => {
    expect(isOverRssSoftLimit(190 * MB, 200 * MB)).toBe(false);
    expect(isOverRssSoftLimit(0, 200 * MB)).toBe(false);
  });

  it("threshold is a parameter, not a constant — moving it flips the outcome", () => {
    // Same fixture RSS = 210 MiB.
    // At threshold=200 MiB, the guard fires.
    expect(isOverRssSoftLimit(210 * MB, 200 * MB)).toBe(true);
    // At threshold=300 MiB, the same RSS is under the ceiling — guard silent.
    // This is the mutation test: a hard-coded `>= 200 * MB` in the
    // implementation would keep firing here and fail the assertion.
    expect(isOverRssSoftLimit(210 * MB, 300 * MB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchNeedsMemoryGuard — classifier for body-bearing FETCHes
// ---------------------------------------------------------------------------

const bodyFull: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "FULL" },
};
const bodyText: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "TEXT" },
};
const bodyPart: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "MIME_PART", partNumber: "1" },
};
const bodyPartText: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "MIME_PART", partNumber: "1", subSection: "TEXT" },
};
const bodyPartHeader: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "MIME_PART", partNumber: "1", subSection: "HEADER" },
};
const bodyPartMime: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "MIME_PART", partNumber: "1", subSection: "MIME" },
};
const bodyHeader: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "HEADER" },
};
const bodyHeaderFields: FetchDataItem = {
  type: "BODY",
  peek: false,
  section: { type: "HEADER_FIELDS", fields: ["FROM"] },
};

describe("fetchNeedsMemoryGuard", () => {
  it("fires on BODY[] / BODY[TEXT] / BODY[<part>] / BODY[<part>.TEXT] / RFC822 / RFC822.TEXT", () => {
    expect(fetchNeedsMemoryGuard([bodyFull])).toBe(true);
    expect(fetchNeedsMemoryGuard([bodyText])).toBe(true);
    expect(fetchNeedsMemoryGuard([bodyPart])).toBe(true);
    expect(fetchNeedsMemoryGuard([bodyPartText])).toBe(true);
    expect(fetchNeedsMemoryGuard([{ type: "RFC822" }])).toBe(true);
    expect(fetchNeedsMemoryGuard([{ type: "RFC822.TEXT" }])).toBe(true);
  });

  it("does NOT fire on FLAGS / UID / INTERNALDATE / RFC822.SIZE / BODYSTRUCTURE / ENVELOPE only", () => {
    const cheap: FetchDataItem[] = [
      { type: "FLAGS" },
      { type: "UID" },
      { type: "INTERNALDATE" },
      { type: "RFC822.SIZE" },
      { type: "RFC822.HEADER" },
      { type: "BODYSTRUCTURE", extensible: true },
      { type: "ENVELOPE" },
      { type: "MODSEQ" },
    ];
    expect(fetchNeedsMemoryGuard(cheap)).toBe(false);
  });

  it("does NOT fire on header-like BODY sections (HEADER, HEADER.FIELDS, <part>.HEADER, <part>.MIME)", () => {
    expect(fetchNeedsMemoryGuard([bodyHeader])).toBe(false);
    expect(fetchNeedsMemoryGuard([bodyHeaderFields])).toBe(false);
    expect(fetchNeedsMemoryGuard([bodyPartHeader])).toBe(false);
    expect(fetchNeedsMemoryGuard([bodyPartMime])).toBe(false);
  });

  it("fires when ANY item is body-bearing (typical iOS batch: FLAGS + BODY[])", () => {
    expect(fetchNeedsMemoryGuard([{ type: "FLAGS" }, bodyFull])).toBe(true);
    expect(fetchNeedsMemoryGuard([{ type: "UID" }, bodyPart])).toBe(true);
  });

  it("empty list does not fire", () => {
    expect(fetchNeedsMemoryGuard([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The combined behaviour under fixture RSS values
// ---------------------------------------------------------------------------

describe("guard fixture — RSS at 210 MiB against threshold 200 MiB", () => {
  it("would refuse a BODY[] fetch (predicate + threshold both true)", () => {
    const rss = 210 * MB;
    const threshold = 200 * MB;
    const needsGuard = fetchNeedsMemoryGuard([bodyFull]);
    const over = isOverRssSoftLimit(rss, threshold);
    expect(needsGuard && over).toBe(true);
  });

  it("would proceed for a BODY[] fetch at RSS=190 MiB", () => {
    const rss = 190 * MB;
    const threshold = 200 * MB;
    const needsGuard = fetchNeedsMemoryGuard([bodyFull]);
    const over = isOverRssSoftLimit(rss, threshold);
    expect(needsGuard && over).toBe(false);
  });

  it("mutation: moving threshold to 300 MiB flips the 210 MiB fixture from refuse to proceed", () => {
    const rss = 210 * MB;
    const before = isOverRssSoftLimit(rss, 200 * MB);
    const after = isOverRssSoftLimit(rss, 300 * MB);
    expect(before).toBe(true);
    expect(after).toBe(false);
  });

  it("would proceed for a FLAGS-only fetch even at RSS=500 MiB (predicate short-circuits)", () => {
    const rss = 500 * MB;
    const threshold = 200 * MB;
    const needsGuard = fetchNeedsMemoryGuard([{ type: "FLAGS" }]);
    expect(needsGuard).toBe(false);
    // The guard is skipped entirely regardless of RSS.
    void isOverRssSoftLimit;
    void rss;
    void threshold;
  });
});

// ---------------------------------------------------------------------------
// End-to-end env-driven threshold — proves the wiring, not just the predicate
// ---------------------------------------------------------------------------

describe("threshold via env — end-to-end", () => {
  it("IMAP_RSS_SOFT_LIMIT_MB=200 breaches at rss=210 MiB, holds at rss=190 MiB", () => {
    process.env.IMAP_RSS_SOFT_LIMIT_MB = "200";
    const threshold = getRssSoftLimitBytes();
    expect(isOverRssSoftLimit(210 * MB, threshold)).toBe(true);
    expect(isOverRssSoftLimit(190 * MB, threshold)).toBe(false);
  });

  it("IMAP_RSS_SOFT_LIMIT_MB=300 lets rss=210 MiB pass — proves the env value drives the compare", () => {
    process.env.IMAP_RSS_SOFT_LIMIT_MB = "300";
    const threshold = getRssSoftLimitBytes();
    expect(isOverRssSoftLimit(210 * MB, threshold)).toBe(false);
    expect(isOverRssSoftLimit(310 * MB, threshold)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isImapMemTraceEnabled
// ---------------------------------------------------------------------------

describe("isImapMemTraceEnabled", () => {
  it("false when unset", () => {
    expect(isImapMemTraceEnabled()).toBe(false);
  });

  it("true only when the value is exactly '1'", () => {
    process.env.IMAP_MEM_TRACE = "1";
    expect(isImapMemTraceEnabled()).toBe(true);
    process.env.IMAP_MEM_TRACE = "true";
    expect(isImapMemTraceEnabled()).toBe(false);
    process.env.IMAP_MEM_TRACE = "0";
    expect(isImapMemTraceEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatMemTraceLine
// ---------------------------------------------------------------------------

describe("formatMemTraceLine", () => {
  it("carries every field named in the issue's instrumentation acceptance", () => {
    const line = formatMemTraceLine({
      cmd: "BODY[]",
      uid: 12,
      mailbox: "craigslist",
      bytesOut: 1_500_000,
      before: { rss: 150 * MB, heapUsed: 40 * MB, external: 8 * MB },
      after: { rss: 200 * MB, heapUsed: 90 * MB, external: 12 * MB },
    });
    expect(line).toContain("cmd=BODY[]");
    expect(line).toContain("uid=12");
    expect(line).toContain("mailbox=craigslist");
    expect(line).toContain("bytes_out=1500000");
    expect(line).toContain("heapUsed=");
    expect(line).toContain("external=");
    expect(line).toContain("rss=");
    // Delta expressed as before->after.
    expect(line).toMatch(/rss=\d+K->\d+K/);
  });

  it("uses '?' when uid is omitted", () => {
    const line = formatMemTraceLine({
      cmd: "BODY[TEXT]",
      mailbox: "INBOX",
      bytesOut: 0,
      before: { rss: 0, heapUsed: 0, external: 0 },
      after: { rss: 0, heapUsed: 0, external: 0 },
    });
    expect(line).toContain("uid=?");
  });
});
