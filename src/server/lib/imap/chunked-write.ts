import { EventEmitter } from "events";

/**
 * Socket-agnostic backpressure-aware chunked writer.
 *
 * Extracted from `ImapSession` so the write loop can be unit-tested
 * against a fake socket without pulling the full session (and its
 * transitive `server` barrel dependency) into leaf test files. The
 * session's `writeChunked` method is a thin wrapper — see `session.ts`.
 *
 * The loop:
 * - Slices `payload` into `CHUNK_BYTES`-sized zero-copy views.
 * - For each slice: `socket.write(slice)`; if that returns false (Node
 *   reports its writable-side high-water mark reached), await `drain`
 *   before writing the next chunk. That's the whole point: without this
 *   await, a retry-storm of multi-MB responses lets the outbound queue
 *   grow unbounded, defeating the RSS cap that motivated this fix.
 * - `close` mid-drain also wakes the awaiter — otherwise a socket that
 *   dies between `write:false` and any potential `drain` would hang the
 *   whole FETCH pipeline on that promise.
 *
 * `onError` receives any exception thrown by `socket.write` so callers
 * can log with their own component tag; it's invoked once per failed
 * write and the function returns early (partial write, no throw).
 */
export interface ChunkedWriteSocket extends EventEmitter {
  destroyed: boolean;
  writable: boolean;
  write(chunk: Uint8Array): boolean;
}

export const CHUNK_BYTES = 64 * 1024; // matches typical TCP high-water mark

export const writeChunkedToSocket = async (
  socket: ChunkedWriteSocket,
  payload: Buffer,
  onError: (err: unknown) => void
): Promise<number> => {
  if (socket.destroyed || !socket.writable) return 0;

  let written = 0;
  for (let offset = 0; offset < payload.byteLength; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, payload.byteLength);
    // Zero-copy view; cast because Node's `socket.write` types constrain
    // the backing ArrayBuffer more tightly than `Buffer.subarray`'s
    // return.
    const slice = payload.subarray(offset, end) as unknown as Uint8Array;

    let ok: boolean;
    try {
      ok = socket.write(slice);
    } catch (error) {
      onError(error);
      return written;
    }
    written += slice.byteLength;

    if (!ok) {
      // Resolve on 'drain' (normal) or 'close' (socket died — no drain
      // is coming and we mustn't hang the awaiting FETCH). Both cleanup
      // paths remove the other listener so nothing leaks.
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          socket.off("close", onClose);
          resolve();
        };
        const onClose = () => {
          socket.off("drain", onDrain);
          resolve();
        };
        socket.once("drain", onDrain);
        socket.once("close", onClose);
      });
    }
  }
  return written;
};
