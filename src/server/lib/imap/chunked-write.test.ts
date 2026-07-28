/**
 * writeChunkedToSocket invariants:
 *  1. Emits the payload in `CHUNK_BYTES`-sized zero-copy views that
 *     reconstruct the original bytes when concatenated.
 *  2. Backpressure: `socket.write` returning false pauses the loop until
 *     'drain' fires. Without this, a retry-storm of multi-MB FETCH
 *     responses lets the Node writable-side buffer grow unbounded,
 *     defeating the RSS cap that motivated the fix.
 *  3. Socket 'close' mid-drain wakes the awaiter — otherwise a socket
 *     that dies between `write:false` and any potential `drain` hangs
 *     the whole FETCH pipeline on that promise.
 *  4. Destroyed / unwritable socket → returns 0 without writing.
 *  5. Return value is the bytes actually written — bumped even on a
 *     partial write (some chunks landed, later one threw). Callers use
 *     this to keep the per-command diagnostic byte counter honest.
 */
import { describe, it, expect, mock } from "bun:test";
import { EventEmitter } from "events";
import {
  writeChunkedToSocket,
  CHUNK_BYTES,
  ChunkedWriteSocket,
} from "./chunked-write";

const makeFakeSocket = (behavior: {
  writeFn: (chunk: Uint8Array) => boolean;
  destroyed?: boolean;
  writable?: boolean;
}): ChunkedWriteSocket => {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    destroyed: behavior.destroyed ?? false,
    writable: behavior.writable ?? true,
    write: behavior.writeFn,
  }) as ChunkedWriteSocket;
};

describe("writeChunkedToSocket", () => {
  it("emits the payload as CHUNK_BYTES-sized chunks that concatenate back to it", async () => {
    const chunks: Buffer[] = [];
    const socket = makeFakeSocket({
      writeFn: (c) => {
        // Buffer.from copies so a later slice reuse can't mutate history.
        chunks.push(Buffer.from(c));
        return true;
      },
    });
    // 3.5 chunks worth — the tail chunk is intentionally short.
    const payload = Buffer.alloc(3 * CHUNK_BYTES + 17, 0x41);
    const written = await writeChunkedToSocket(socket, payload, () => {});
    expect(written).toBe(payload.byteLength);
    expect(chunks.length).toBe(4);
    expect(chunks[0].byteLength).toBe(CHUNK_BYTES);
    expect(chunks[1].byteLength).toBe(CHUNK_BYTES);
    expect(chunks[2].byteLength).toBe(CHUNK_BYTES);
    expect(chunks[3].byteLength).toBe(17); // tail
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it("awaits 'drain' before continuing when socket.write returns false", async () => {
    let writeCount = 0;
    const socket = makeFakeSocket({
      writeFn: () => {
        writeCount += 1;
        // Only the first write reports backpressure — 2nd must wait for
        // a 'drain' event before firing.
        return writeCount !== 1;
      },
    });
    const payload = Buffer.alloc(2 * CHUNK_BYTES, 0x42);
    const done = writeChunkedToSocket(socket, payload, () => {});
    // Let the promise reach the drain-await; two microtask flushes cover
    // it comfortably.
    await Promise.resolve();
    await Promise.resolve();
    expect(writeCount).toBe(1); // 2nd write is parked on drain
    socket.emit("drain");
    const written = await done;
    expect(writeCount).toBe(2);
    expect(written).toBe(payload.byteLength);
  });

  it("resolves when the socket 'close's mid-drain (does not hang)", async () => {
    // Permanent backpressure: every write returns false. Without the
    // 'close' fallback the awaiter would sit forever.
    const socket = makeFakeSocket({ writeFn: () => false });
    const payload = Buffer.alloc(CHUNK_BYTES, 0x43);
    const done = writeChunkedToSocket(socket, payload, () => {});
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("close");
    // If this test hangs, the close-fallback is broken.
    const written = await done;
    // Byte counter bumped for the queued chunk even though the socket
    // died before drain — write() DID succeed (returned false), the OS
    // has the bytes.
    expect(written).toBe(CHUNK_BYTES);
  });

  it("returns 0 without writing when the socket is destroyed", async () => {
    const write = mock(() => true);
    const socket = makeFakeSocket({ writeFn: write, destroyed: true });
    const written = await writeChunkedToSocket(
      socket,
      Buffer.alloc(CHUNK_BYTES),
      () => {}
    );
    expect(written).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns 0 without writing when the socket is unwritable", async () => {
    const write = mock(() => true);
    const socket = makeFakeSocket({ writeFn: write, writable: false });
    const written = await writeChunkedToSocket(
      socket,
      Buffer.alloc(CHUNK_BYTES),
      () => {}
    );
    expect(written).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("calls onError and returns the running written count when write throws mid-payload", async () => {
    let writes = 0;
    const errors: unknown[] = [];
    const socket = makeFakeSocket({
      writeFn: () => {
        writes += 1;
        if (writes === 3) throw new Error("EPIPE");
        return true;
      },
    });
    const payload = Buffer.alloc(4 * CHUNK_BYTES, 0x44);
    const written = await writeChunkedToSocket(socket, payload, (e) =>
      errors.push(e)
    );
    // Two chunks landed before the third threw.
    expect(written).toBe(2 * CHUNK_BYTES);
    expect(writes).toBe(3);
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("EPIPE");
  });
});
