/**
 * Octets a session's socket has delivered and its drain loop has not read yet.
 *
 * A plain `Buffer` cannot hold them at a bounded cost, because the two things
 * the drain does to it — take a segment, consume a prefix — are both whole
 * copies:
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

// Segments held unjoined. Deferring the join trades octets moved for segment
// objects retained, and the peer sets the exchange rate — one object per TCP
// segment, so a payload dribbled an octet at a time buys far more bookkeeping
// than payload. Reaching the ceiling joins early: that copy is bounded and
// rare, while the object count is bounded always. A `data` event carries up to
// 64 KiB, so a message-sized literal at any realistic segmentation never gets
// near it.
const MAX_PENDING_SEGMENTS = 4096;

export class SessionBuffer {
  /** Contiguous block; its unread octets start at `cursor`. */
  private block: Buffer = EMPTY;
  private cursor = 0;
  /** Segments taken since the last join, in arrival order. */
  private segments: Uint8Array[] = [];
  private segmentBytes = 0;

  /** Unread octets, joined and unjoined alike. */
  get length(): number {
    return this.block.length - this.cursor + this.segmentBytes;
  }

  push(segment: Buffer): void {
    if (segment.length === 0) return;
    this.segments.push(segment as unknown as Uint8Array);
    this.segmentBytes += segment.length;
    if (this.segments.length >= MAX_PENDING_SEGMENTS) this.join();
  }

  clear(): void {
    this.block = EMPTY;
    this.cursor = 0;
    this.segments = [];
    this.segmentBytes = 0;
  }

  /**
   * Index of the first CRLF among the unread octets, relative to the first of
   * them, or -1. Joins, because a terminator can straddle two segments.
   */
  indexOfCrlf(): number {
    this.join();
    const at = this.block.indexOf(CRLF, this.cursor);
    return at === -1 ? -1 : at - this.cursor;
  }

  /** UTF-8 decode of unread octets `[start, end)`. Does not consume them. */
  toString(start: number, end: number): string {
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

  private join(): void {
    if (this.segmentBytes === 0) return;
    this.block = this.rebuild(this.segments, this.segmentBytes);
    this.cursor = 0;
    this.segments = [];
    this.segmentBytes = 0;
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
