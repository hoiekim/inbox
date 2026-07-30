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

/**
 * Consume an async iterable of `Buffer` chunks and write each to the
 * socket with the same backpressure discipline as `writeChunkedToSocket`
 * (await `drain` when `socket.write` reports its high-water mark).
 *
 * Distinct from `writeChunkedToSocket` because the source is a stream
 * (produced by `buildFullMessageStream` for BODY[] fetches) rather than
 * a pre-materialized Buffer: chunk boundaries are determined by the
 * producer, not by fixed CHUNK_BYTES slicing. Producer is expected to
 * yield chunks in the CHUNK_BYTES ballpark so socket writes align
 * naturally with the high-water mark.
 *
 * Same close-during-drain guard as writeChunkedToSocket: if the socket
 * dies mid-write, return early with the partial count instead of
 * hanging on a drain that will never fire.
 */
export const writeStreamToSocket = async (
  socket: ChunkedWriteSocket,
  chunks: AsyncIterable<Buffer>,
  onError: (err: unknown) => void
): Promise<number> => {
  if (socket.destroyed || !socket.writable) return 0;
  let written = 0;
  for await (const chunk of chunks) {
    if (socket.destroyed || !socket.writable) return written;
    let ok: boolean;
    try {
      ok = socket.write(chunk as unknown as Uint8Array);
    } catch (error) {
      onError(error);
      return written;
    }
    written += chunk.byteLength;
    if (!ok) {
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
      if (socket.destroyed || !socket.writable) return written;
    }
  }
  return written;
};

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
      // If the wake came from 'close', the socket is dead: a further
      // write returns false (Node emits ERR_STREAM_DESTROYED async, no
      // sync throw for the try/catch), so continuing the loop would
      // re-await a drain/close that never fires and wedge the FETCH.
      if (socket.destroyed || !socket.writable) return written;
    }
  }
  return written;
};
