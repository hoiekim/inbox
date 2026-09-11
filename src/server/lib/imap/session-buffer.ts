/**
 * Octets a session's socket has delivered and its drain loop has not read yet.
 *
 * A plain `Buffer` cannot hold them at a bounded cost, because everything the
 * drain does to it — take a segment, search for a line terminator, consume a
 * prefix — is a whole copy:
 *
 * - **Taking a segment.** `Buffer.concat([held, segment])` copies everything
 *   received so far, once per TCP segment, so a payload arriving in `n`
 *   segments moves `O(n²)` octets on the shared event loop before it is even
 *   complete. None of those passes lets the drain progress: it parks at
 *   `length < literalBytesNeeded` until the last segment lands. A 32 MiB
 *   APPEND at 64 KiB segments spends ~1.6 s of `memcpy` this way, and the
 *   message sizes mainstream providers accept make that ordinary iOS Mail
 *   traffic, not only an attack. Segments are held on a list instead, and
 *   joined once — when a read actually needs them contiguous.
 *
 * - **Searching for the terminator.** The line splitter wakes on every segment
 *   too, and it runs before authentication, so joining in order to search puts
 *   the same `O(n²)` back on command text that carries no CRLF. The search
 *   walks the held octets in place and joins only once it has found one.
 *
 * - **Consuming a prefix.** Copying the residual out on every read is
 *   `O(residual)` per read, so a command chaining `k` literals copies its own
 *   tail `k` times. Reads move a cursor instead, and the residual is copied
 *   out only once the cursor has passed halfway — at most one octet moved per
 *   octet consumed, amortized, while still handing back the block a large
 *   payload was sliced out of rather than leaving a view pinning it.
 *
 * Offsets and lengths are octets throughout: `{N}` counts octets, and a UTF-8
 * decode would make them UTF-16 code units.
 */

const EMPTY = Buffer.alloc(0);

const CRLF = Buffer.from("\r\n") as unknown as Uint8Array;
const CR = 0x0d;
const LF = 0x0a;

// Segments held unmerged. Deferring the join trades octets moved for segment
// objects retained, and the peer sets the exchange rate — one object per TCP
// segment, so a payload dribbled an octet at a time buys far more bookkeeping
// than payload. Reaching the ceiling merges that run into a single segment and
// leaves everything already held alone, so each octet is copied into a run once
// and never again: the object count is bounded, and the total stays linear in
// the wire rather than quadratic at 1/4096 the frequency. A `data` event
// carries up to 64 KiB, so a message-sized literal at any realistic
// segmentation never reaches it.
const MAX_PENDING_SEGMENTS = 4096;

export class SessionBuffer {
  /** Contiguous block; its unread octets start at `cursor`. */
  private block: Buffer = EMPTY;
  private cursor = 0;
  /** Segments taken since the last join, in arrival order. */
  private segments: Uint8Array[] = [];
  private segmentBytes = 0;
  /** Leading `segments` entries already merged into runs of their own. */
  private mergedRuns = 0;
  /** Unread octets a search has already found to hold no terminator. */
  private scannedUpTo = 0;
  /**
   * Where the search that scanned them stopped: the `segments` entry it was
   * walking, and the unread offset that entry begins at. Carrying the octet
   * count alone still leaves every search re-deriving that position one entry
   * at a time, which is `O(#segments)` per arriving segment whether or not it
   * reads a single new octet — the same quadratic, paid in list steps rather
   * than in `memcpy`.
   *
   * `scanBase` is where `segments[scanIndex]` begins, so it moves with the
   * octets ahead of it and starts over whenever the list does. A search
   * resumes only while it is behind the octet that search starts from, which
   * makes a position left stale by a future caller cost one full walk rather
   * than a terminator already on the wire.
   */
  private scanIndex = 0;
  private scanBase = 0;

  /** Unread octets, joined and unjoined alike. */
  get length(): number {
    return this.block.length - this.cursor + this.segmentBytes;
  }

  push(segment: Buffer): void {
    if (segment.length === 0) return;
    this.segments.push(segment as unknown as Uint8Array);
    this.segmentBytes += segment.length;
    if (this.segments.length - this.mergedRuns >= MAX_PENDING_SEGMENTS) {
      this.mergePendingRun();
    }
  }

  clear(): void {
    this.block = EMPTY;
    this.cursor = 0;
    this.segments = [];
    this.segmentBytes = 0;
    this.mergedRuns = 0;
    this.scannedUpTo = 0;
    this.scanIndex = 0;
    this.scanBase = 0;
  }

  /**
   * Index of the first CRLF among the unread octets, relative to the first of
   * them, or -1.
   *
   * `scannedUpTo` and the list position beside it carry across calls, so a
   * prefix already known to hold no terminator is neither walked nor stepped
   * over again per arriving segment. The resumed search starts one octet back,
   * because the `\r` of a pair can be the last octet the previous call saw.
   */
  indexOfCrlf(): number {
    const at = this.findCrlf(Math.max(0, this.scannedUpTo - 1));
    if (at === -1) {
      this.scannedUpTo = this.length;
      return -1;
    }
    this.join();
    return at;
  }

  /** UTF-8 decode of unread octets `[start, end)`. Does not consume them. */
  decode(start: number, end: number): string {
    this.join();
    return this.block.toString("utf8", this.cursor + start, this.cursor + end);
  }

  consume(count: number): void {
    // Every read joins before it returns, so a consume that follows one stays
    // inside the block. The discard path consumes without reading, and it is
    // the one caller that can reach past it — unjoined segments are held
    // octets too, and dropping the block alone would leave them behind as the
    // head of the next command.
    if (count > this.block.length - this.cursor) this.join();
    this.cursor += count;
    this.scannedUpTo = Math.max(0, this.scannedUpTo - count);
    this.scanBase = Math.max(0, this.scanBase - count);
    if (this.cursor >= this.block.length) {
      this.block = EMPTY;
      this.cursor = 0;
      return;
    }
    // Past halfway the residual is no larger than what has already been read,
    // so copying it out costs no more than the octets that paid for it — and
    // it releases the block, which after a message-sized literal is the whole
    // message being held for a command tail of a few dozen octets.
    if (this.cursor * 2 >= this.block.length) {
      this.block = this.rebuild();
      this.cursor = 0;
    }
  }

  /**
   * First CRLF at or after unread offset `from`, or -1. Walks the block and
   * then each held segment, carrying a trailing `\r` across every boundary,
   * and copies nothing.
   */
  private findCrlf(from: number): number {
    // Unread offset of a `\r` ending the piece just walked, or -1.
    let danglingCr = -1;
    let index = 0;
    let base = this.block.length - this.cursor;
    // A stored position at or before `from` puts every octet ahead of it —
    // the block's included — behind the resume point, so neither is walked.
    if (this.scanIndex > 0 && this.scanBase <= from) {
      index = this.scanIndex;
      base = this.scanBase;
    } else if (base > from) {
      const at = this.block.indexOf(CRLF, this.cursor + from);
      if (at !== -1) return at - this.cursor;
      if (this.block[this.block.length - 1] === CR) danglingCr = base - 1;
    }
    let stoppedAt = index;
    let stoppedBase = base;
    for (; index < this.segments.length; index++) {
      stoppedAt = index;
      stoppedBase = base;
      const segment = this.segments[index] as unknown as Buffer;
      const end = base + segment.length;
      if (end <= from) {
        base = end;
        danglingCr = -1;
        continue;
      }
      const start = Math.max(0, from - base);
      if (start === 0 && danglingCr !== -1 && segment[0] === LF) {
        return danglingCr;
      }
      const at = segment.indexOf(CRLF, start);
      if (at !== -1) return base + at;
      danglingCr = segment[segment.length - 1] === CR ? end - 1 : -1;
      base = end;
    }
    this.scanIndex = stoppedAt;
    this.scanBase = stoppedBase;
    return -1;
  }

  private mergePendingRun(): void {
    const run = this.segments.splice(this.mergedRuns);
    let runBytes = 0;
    for (const segment of run) runBytes += segment.length;
    this.segments.push(Buffer.concat(run, runBytes) as unknown as Uint8Array);
    this.mergedRuns = this.segments.length;
    // The entries the run collapsed into are gone, so a resume point indexing
    // them indexes past the end of the list — and a search that walks nothing
    // finds no terminator. Starting over costs one walk of the merged entries,
    // once per ceiling crossed, against the 4096 pushes that reached it.
    this.scanIndex = 0;
    this.scanBase = this.block.length - this.cursor;
  }

  private join(): void {
    if (this.segmentBytes === 0) return;
    this.block = this.rebuild(this.segments, this.segmentBytes);
    this.cursor = 0;
    this.segments = [];
    this.segmentBytes = 0;
    this.mergedRuns = 0;
    this.scanIndex = 0;
    this.scanBase = this.block.length;
  }

  /**
   * The unread octets, followed by `extra`, in a block of their own. `concat`
   * rather than `subarray` even for a lone view: it always allocates its own
   * exactly-sized backing store, so the parent allocation is released instead
   * of staying pinned by the view.
   */
  private rebuild(extra: readonly Uint8Array[] = [], extraBytes = 0): Buffer {
    const unread = this.block.length - this.cursor;
    return Buffer.concat(
      [this.block.subarray(this.cursor) as unknown as Uint8Array, ...extra],
      unread + extraBytes
    );
  }
}
