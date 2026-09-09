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

const readLine = (buffer: SessionBuffer): string | null => {
  const end = buffer.indexOfCrlf();
  if (end === -1) return null;
  const line = buffer.toString(0, end);
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
      expect(buffer.toString(0, 8)).toBe("AAAAAAAA");
    });
    expect(reading.calls).toBe(1);
    expect(reading.bytes).toBe(512 * 4096);
  });

  it("joins early once the pending segment list reaches its ceiling", async () => {
    const buffer = new SessionBuffer();
    const octet = Buffer.from("x");

    // A peer sets the segment size, so deferring forever trades a bounded copy
    // for an unbounded number of retained segment objects.
    const arriving = await accountCopies(() => {
      for (let i = 0; i < SEGMENT_CEILING; i++) buffer.push(octet);
    });

    expect(arriving.calls).toBe(1);
    expect(buffer.length).toBe(SEGMENT_CEILING);
    expect(buffer.toString(0, 4)).toBe("xxxx");
  });

  it("ignores an empty segment", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.alloc(0));
    expect(buffer.length).toBe(0);
    expect(buffer.indexOfCrlf()).toBe(-1);
  });
});

describe("SessionBuffer reads", () => {
  it("finds a CRLF straddling two segments", () => {
    const buffer = new SessionBuffer();
    buffer.push(Buffer.from("A1 NOOP\r"));
    buffer.push(Buffer.from("\nA2 NOOP\r\n"));

    expect(readLine(buffer)).toBe("A1 NOOP");
    expect(readLine(buffer)).toBe("A2 NOOP");
    expect(readLine(buffer)).toBe(null);
    expect(buffer.length).toBe(0);
  });

  it("reassembles a payload delivered one octet at a time", () => {
    const buffer = new SessionBuffer();
    const payload = "héllo wörld";
    for (const octet of Buffer.from(payload)) buffer.push(Buffer.from([octet]));

    const octets = Buffer.byteLength(payload);
    expect(buffer.length).toBe(octets);
    expect(buffer.toString(0, octets)).toBe(payload);
  });

  it("counts octets, not code units", () => {
    const buffer = new SessionBuffer();
    // Two octets each; a UTF-16 length would read them as one.
    buffer.push(Buffer.from("ééé"));
    expect(buffer.length).toBe(6);
    expect(buffer.toString(0, 2)).toBe("é");
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

    expect(buffer.toString(0, 1)).toBe("A");
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
    buffer.toString(0, 2);
    buffer.push(Buffer.from("A2 NOOP\r\n"));

    buffer.clear();

    expect(buffer.length).toBe(0);
    expect(buffer.indexOfCrlf()).toBe(-1);
  });
});
