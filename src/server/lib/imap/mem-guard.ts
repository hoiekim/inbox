/**
 * Container memory-pressure defense for IMAP FETCH: a soft RSS ceiling that
 * refuses one hot socket's body fetch instead of letting the whole container
 * OOM and take every open IMAP + SMTP session down with it.
 *
 * See `docs/OPS_MEMORY_PRESSURE.md` for the operational context, the
 * unverified root-cause hypotheses this does NOT close, and how the two env
 * vars (`IMAP_RSS_SOFT_LIMIT_MB`, `IMAP_MEM_TRACE`) are meant to be flipped.
 */

import { FetchDataItem } from "./types";

export const DEFAULT_RSS_SOFT_LIMIT_MB = 200;

/**
 * Read the RSS soft-limit threshold in bytes. `IMAP_RSS_SOFT_LIMIT_MB`
 * overrides; a missing / non-numeric / non-positive value falls back to
 * `DEFAULT_RSS_SOFT_LIMIT_MB`. Read on every call so a test can set the env
 * var and observe the change without module re-import — the module-scope
 * `const CAPACITY = parseEnv()` pattern used by `body-budget` is untestable
 * against ESM hoisting.
 */
export const getRssSoftLimitBytes = (): number => {
  const raw = process.env.IMAP_RSS_SOFT_LIMIT_MB;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const mb =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RSS_SOFT_LIMIT_MB;
  return mb * 1024 * 1024;
};

/** Pure predicate: is the reported RSS at or above the threshold? */
export const isOverRssSoftLimit = (
  rssBytes: number,
  thresholdBytes: number
): boolean => rssBytes >= thresholdBytes;

/**
 * Whether a FETCH's data-item list carries any body-bearing section — i.e.
 * a section whose response streams the mail body: `BODY[]`, `BODY[TEXT]`,
 * `BODY[<part>]` (bare / `.TEXT`), `RFC822`, `RFC822.TEXT`. Header-like
 * sections (`HEADER`, `HEADER.FIELDS`, `<part>.HEADER`, `<part>.MIME`) are
 * few-KiB materialized responses and do not consume the guard, so a
 * `UID FETCH X (FLAGS)` or `UID FETCH X BODY[HEADER]` under memory pressure
 * still completes.
 */
export const fetchNeedsMemoryGuard = (dataItems: FetchDataItem[]): boolean =>
  dataItems.some(isBodyBearingItem);

const isBodyBearingItem = (item: FetchDataItem): boolean => {
  if (item.type === "RFC822") return true;
  if (item.type === "RFC822.TEXT") return true;
  if (item.type !== "BODY") return false;
  const section = item.section;
  if (section.type === "FULL") return true;
  if (section.type === "TEXT") return true;
  if (section.type === "HEADER") return false;
  if (section.type === "HEADER_FIELDS") return false;
  if (section.type === "MIME_PART") {
    return section.subSection !== "HEADER" && section.subSection !== "MIME";
  }
  return false;
};

// ---------------------------------------------------------------------------
// Per-BODY[] memoryUsage() instrumentation
// ---------------------------------------------------------------------------

/** Structured snapshot of `process.memoryUsage()` — only the fields we log. */
export interface MemSnapshot {
  rss: number;
  heapUsed: number;
  external: number;
}

export const snapshotMemory = (): MemSnapshot => {
  const u = process.memoryUsage();
  return { rss: u.rss, heapUsed: u.heapUsed, external: u.external };
};

/** Read whether per-emit instrumentation is enabled on this call. */
export const isImapMemTraceEnabled = (): boolean =>
  process.env.IMAP_MEM_TRACE === "1";

const kib = (n: number): number => Math.round(n / 1024);

/**
 * Format one `RSS_DELTA` line for a single BODY[] response emission. Kept
 * as a pure formatter so tests can assert on the shape without a logger
 * capture harness.
 */
export const formatMemTraceLine = (opts: {
  cmd: string;
  uid?: number;
  mailbox: string;
  bytesOut: number;
  before: MemSnapshot;
  after: MemSnapshot;
}): string => {
  const uid = opts.uid ?? "?";
  return (
    `RSS_DELTA cmd=${opts.cmd} uid=${uid} mailbox=${opts.mailbox} ` +
    `heapUsed=${kib(opts.before.heapUsed)}K->${kib(opts.after.heapUsed)}K ` +
    `external=${kib(opts.before.external)}K->${kib(opts.after.external)}K ` +
    `rss=${kib(opts.before.rss)}K->${kib(opts.after.rss)}K ` +
    `bytes_out=${opts.bytesOut}`
  );
};
