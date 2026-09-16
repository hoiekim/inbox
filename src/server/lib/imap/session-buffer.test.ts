/**
 * The session's octet reader.
 *
 * Its whole reason to exist is cost, so most of these assert how much it
 * copies, not only what it returns: holding segments unjoined and moving a
 * cursor instead of the residual is what keeps a message-sized APPEND from
 * costing `O(segments²)` octets of `memcpy` on the shared event loop, and what
 * keeps a chained command from copying its own tail once per link.
 *
 * Every copy the reader makes goes through `Buffer.concat` with an explicit
 * total, so spying on it accounts for all of them.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { SessionBuffer } from "./session-buffer";

// Mirrors MAX_PENDING_SEGMENTS in session-buffer.ts. Deliberately re-stated
// rather than imported: a test that reads the same symbol it is checking
// cannot catch the ceiling being widened.
const SEGMENT_CEILING = 4096;

/** Octets the reader copied while `run` executed, and how many times. */
const accountCopies = async (run: () => void | Promise<void>) => {
  const spy = spyOn(Buffer, "concat");
  try {
    await run();
    const copies = spy.mock.calls as unknown as [Uint8Array[], number][];
    return {
      calls: copies.length,
      bytes: copies.reduce((total, [, length]) => total + length, 0)
    };
  } finally {
    spy.mockRestore();
  }
};

/**
 * `segments` slots the reader indexed while `run` executed. The in-place
 * search reads no new octet to step over an entry it has already walked, so
 * list steps — not octets — are what its cost is denominated in.
 */
const accountSegmentWalk = (buffer: SessionBuffer, run: () => void) => {
  const internals = buffer as unknown as { segments: Uint8Array[] };
  let steps = 0;
  internals.segments = new Proxy(internals.segments, {
    get(target, key, receiver) {
      if (typeof key === "string" && Number.isInteger(Number(key))) steps++;
      return Reflect.get(target, key, receiver);
    }
  });
  run();
  return steps;
};

const readLine = (buffer: SessionBuffer): string | null => {
  const end = buffer.indexOfCrlf();
  if (end === -1) return null;
  const line = buffer.decode(0, end);
  buffer.consume(end + 2);
  return line;
};

describe("SessionBuffer accumulation", () => {
  it("takes segments without copying, and joins once when a read needs them", async () => {
    const buffer = new SessionBuffer();
    const segment = Buffer.alloc(4096, 0x41);

    const arriving = await accountCopies(() => {
      for (let i = 0; i < 512; i++) buffer.push(segment);
    });
    // The defect this replaces copied the whole buffer per segment: 512
    // segments of 4 KiB would have moved ~512 MiB before any read.
    expect(arriving.calls).toBe(0);
    expect(buffer.length).toBe(512 * 4096);

    const reading = await accountCopies(() => {
      expect(buffer.decode(0, 8)).toBe("AAAAAAAA");
    });
    expect(reading.calls).toBe(1);
    expect(reading.bytes).toBe(512 * 4096);
  });

  it("merges the run that reached the ceiling, not everything held", async () => {
    const buffer = new SessionBuffer();
    const held = 1024 * 1024;
    buffer.push(Buffer.alloc(held, 0x41));
    buffer.decode(0, 1);
    const octet = Buffer.from("x");

    // A peer sets the segment size, so deferring forever trades a bounded copy
    // for an unbounded number of retained segment objects. Rebuilding what is
    // already held alongside the run would re-copy every octet once per
    // ceiling crossed, which is the same quadratic at 1/4096 the frequency.
    const arriving = await accountCopies(() => {
      for (let i = 0; i < SEGMENT_CEILING; i++) buffer.push(octet);
    });

    expect(arriving.calls).toBe(1);
    expect(arriving.bytes).toBe(SEGMENT_CEILING);
    expect(buffer.length).toBe(held + SEGMENT_CEILING);
    expect(buffer.decode(held, held + 4)).toBe("xxxx");
  });

  it("keeps the octets moved linear across repeated ceilings", async () => {
    const buffer = new SessionBuffer();
    const octet = Buffer.from("x");
    const total = SEGMENT_CEILING * 8;

    const arriving = await accountCopies(() => {
      for (let i = 0; i < total; i++) buffer.push(octet);
    });

    // Each octet is merged into a run once and never again, so the total is
    // the wire — not the wire times the number of ceilings it crossed.
    expect(arriving.bytes).toBe(total);
    expect(buffer.length).toBe(total);
    expect(buffer.decode(total - 2, total)).toBe("xx");
  });

  it("scans an unterminated command line without joining", async () => {
    const buffer = new SessionBuffer();
    const segment = Buffer.alloc(64, 0x41);
    const segments = 1024;

    // The shape the drain loop actually produces, and the one the earlier
    // accumulation tests miss by pushing everything before they read: every
    // arriving segment wakes the drain, which reaches the line splitter while
    // the line is still unterminated. Searching by joining would copy
    // everything held per segment — 32 MiB of `memcpy` for 64 KiB of wire, on
    // a path that runs before LOGIN.
    const scanning = await accountCopies(() => {
      for (let i = 0; i < segments; i++) {
        buffer.push(segment);
        expect(buffer.indexOfCrlf()).toBe(-1);
      }
    });

    expect(scanning.bytes).toBe(0);
    expect(buffer.length).toBe(segments * 64);
  });

  it("resumes the walk where the last scan stopped, not at the head of the list", () => {
    const buffer = new SessionBuffer();
    const octet = Buffer.from("x");
    // Under the ceiling, so the walk is the only thing being counted.
    const segments = SEGMENT_CEILING - 96;

    // The same wire as the scan above, in the units its cost is actually paid
    // in. Copying nothing is not the whole property: a search that carries the
    // octet count alone still steps over every entry already walked to find
    // where it left off, so the octet account reads zero under both
    // implementations while one of them is quadratic in the segment count.
    const steps = accountSegmentWalk(buffer, () => {
      for (let i = 0; i < segments; i++) {
        buffer.push(octet);
        expect(buffer.indexOfCrlf()).toBe(-1);
      }
    });

    // Resuming visits the entry it stopped in and the ones that arrived since
    // — a constant here, against the `segments / 2` a walk from index 0 pays.
    expect(steps).toBeLessThan(4 * segments);
    expect(buffer.length).toBe(segments);
  });

  it("keeps the resume point on the entry a merged run became", () => {
    const buffer = new SessionBuffer();
    const octet = Buffer.from("x");
    const segments = SEGMENT_CEILING + 64;

    // The ceiling collapses the run the search was walking into a single
    // entry, so a resume point still indexing the run's own entries indexes
    // past the end of the list — and a search that walks nothing finds no
    // terminator, on a line the peer has already finished sending.
    for (let i = 0; i < segments; i++) {
      buffer.push(octet);
      expect(buffer.indexOfCrlf()).toBe(-1);
    }
    buffer.push(Buffer.from("\r\n"));

    expect(buffer.indexOfCrlf()).toBe(segments);
    expect(buffer.decode(0, 3)).toBe("xxx");
  });

  it("resumes from the shifted position after a consume that leaves segments held", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("A1 NOOP\r\nPREFIX"));
    expect(readLine(buffer)).toBe("A1 NOOP");

    const octet = Buffer.from("x");
    const segments = 512;
    for (let i = 0; i < segments; i++) {
      buffer.push(octet);
      expect(buffer.indexOfCrlf()).toBe(-1);
    }

    // Two conditions decide whether an unshifted resume point is reachable at
    // all, and missing either one makes the shift and its absence return the
    // same index. The entry the search stopped in has to be longer than what
    // the consume takes, or the unshifted position is far enough ahead of the
    // octet the next search starts from to fail the guard, and the full walk
    // it falls back to rewrites the position correctly. And the terminator has
    // to arrive in the first search after the consume, because any further
    // push puts the position ahead of that octet again and heals it the same
    // way.
    const tail = Buffer.from("yyyyyyyyyy");
    buffer.push(tail);
    expect(buffer.indexOfCrlf()).toBe(-1);

    // The discard path consumes octets it never read, so the block shrinks
    // while the segments behind it stay where they are. Every unread offset
    // ahead of them moves toward the front, and a resume point that does not
    // move with them reads the entry it stopped in as beginning later than it
    // does — a terminator found at an index past the one the peer sent, so the
    // line handed to the parser keeps a trailing `\r` and the consume that
    // follows eats the first octet of the next command.
    buffer.consume(3);
    buffer.push(Buffer.from("\r\n"));

    expect(buffer.indexOfCrlf()).toBe(3 + segments + tail.length);
    expect(buffer.decode(0, 3)).toBe("FIX");
  });

  it("ignores an empty segment", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.alloc(0));
    expect(buffer.length).toBe(0);
    expect(buffer.indexOfCrlf()).toBe(-1);
  });
});

describe("SessionBuffer reads", () => {
  it("finds a CRLF straddling the boundary a scan stopped at", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("A1 NO"));
    expect(buffer.indexOfCrlf()).toBe(-1);
    buffer.push(Buffer.from("OP\r"));
    expect(buffer.indexOfCrlf()).toBe(-1);
    buffer.push(Buffer.from("\nA2 NOOP\r\n"));

    // The `\r` is the last octet the second scan saw, so a resume that starts
    // where it stopped rather than one octet back never sees the pair, and the
    // session wedges on a command line it has already been sent in full.
    expect(readLine(buffer)).toBe("A1 NOOP");
    expect(readLine(buffer)).toBe("A2 NOOP");
    expect(buffer.length).toBe(0);
  });

  it("resumes the search from the right place after a consume", () => {
    const buffer = new SessionBuffer();
    // Longer than the line behind it, so a resume offset left where the first
    // line ended lands past the second line's terminator rather than short of
    // it — the shape that actually loses the terminator.
    const first = `A1 SEARCH SUBJECT ${"x".repeat(64)}`;
    buffer.push(Buffer.from(first));
    expect(buffer.indexOfCrlf()).toBe(-1);
    buffer.push(Buffer.from("\r\nA2 NOOP\r\n"));

    // Consuming shifts every remaining octet toward the front, so a resume
    // offset carried across one has to shift with them. One that does not
    // skips a terminator already on the wire, and the session wedges holding a
    // command it was sent in full.
    expect(readLine(buffer)).toBe(first);
    expect(readLine(buffer)).toBe("A2 NOOP");
    expect(buffer.length).toBe(0);
  });

  it("finds a CRLF straddling two segments", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("A1 NOOP\r"));
    buffer.push(Buffer.from("\nA2 NOOP\r\n"));

    expect(readLine(buffer)).toBe("A1 NOOP");
    expect(readLine(buffer)).toBe("A2 NOOP");
    expect(readLine(buffer)).toBe(null);
    expect(buffer.length).toBe(0);
  });

  it("finds a CRLF straddling the joined block and a new segment", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("A1 NOOP\r\nA2 NOOP\r"));
    expect(readLine(buffer)).toBe("A1 NOOP");

    // That read joined, so the `\r` left behind is the block's last octet and
    // the `\n` answering it arrives as a segment. A search that walks the two
    // halves independently reads straight past the pair and hands the drain
    // two commands as one line.
    buffer.push(Buffer.from("\nA3 NOOP\r\n"));

    expect(readLine(buffer)).toBe("A2 NOOP");
    expect(readLine(buffer)).toBe("A3 NOOP");
    expect(buffer.length).toBe(0);
  });

  it("reassembles a payload delivered one octet at a time", () => {
    const buffer = new SessionBuffer();
    const payload = "héllo wörld";
    for (const octet of Buffer.from(payload)) buffer.push(Buffer.from([octet]));

    const octets = Buffer.byteLength(payload);
    expect(buffer.length).toBe(octets);
    expect(buffer.decode(0, octets)).toBe(payload);
  });

  it("counts octets, not code units", () => {
    const buffer = new SessionBuffer();
    // Two octets each; a UTF-16 length would read them as one.
    buffer.push(Buffer.from("ééé"));
    expect(buffer.length).toBe(6);
    expect(buffer.decode(0, 2)).toBe("é");
  });

  it("keeps reads correct across the compaction the cursor triggers", () => {
    const buffer = new SessionBuffer();
    const lines = Array.from({ length: 20 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    buffer.push(Buffer.from(lines.map((l) => `${l}\r\n`).join("")));

    // The cursor passes halfway partway through, so the block is rebuilt while
    // unread octets remain — the reads after it must resume where they left
    // off, not at the old cursor.
    expect(lines.map(() => readLine(buffer))).toEqual(lines);
    expect(buffer.length).toBe(0);
  });
});

describe("SessionBuffer consumption", () => {
  it("drops unjoined segments a consume reaches past", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("0123456789"));
    buffer.push(Buffer.from("abcdeA1 NOOP\r\n"));

    // The discard path consumes octets it never read, so `count` can span the
    // joined block and the segments behind it. Leaving those behind would make
    // them the head of the next command.
    buffer.consume(15);

    expect(buffer.length).toBe(9);
    expect(readLine(buffer)).toBe("A1 NOOP");
  });

  it("releases the block a large payload was sliced out of", () => {
    const buffer = new SessionBuffer();
    const payload = 4 * 1024 * 1024;
    buffer.push(Buffer.alloc(payload, 0x41));
    buffer.push(Buffer.from(" tail\r\n"));

    expect(buffer.decode(0, 1)).toBe("A");
    buffer.consume(payload);

    // A view would keep the whole payload alive for as long as the session
    // stays idle, per connection, against the container's memory ceiling.
    const retained = (buffer as unknown as { block: Buffer }).block.length;
    expect(retained).toBeLessThan(1024);
    expect(readLine(buffer)).toBe(" tail");
  });

  it("copies no more than the octets consumed while draining in small reads", async () => {
    const buffer = new SessionBuffer();
    const line = "A1 NOOP\r\n";
    const total = 64 * 1024;
    buffer.push(Buffer.from(line.repeat(total / line.length)));

    // Copying the residual out per read is what makes a chained command copy
    // its own tail once per link. Amortized, the cursor holds the total to the
    // octets that paid for it.
    const draining = await accountCopies(() => {
      while (readLine(buffer) !== null);
    });

    expect(buffer.length).toBe(0);
    expect(draining.bytes).toBeLessThanOrEqual(2 * total);
  });

  it("forgets everything on clear", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("A1 NOOP\r\n"));
    buffer.decode(0, 2);
    buffer.push(Buffer.from("A2 NOOP\r\n"));

    buffer.clear();

    expect(buffer.length).toBe(0);
    expect(buffer.indexOfCrlf()).toBe(-1);
  });
});
