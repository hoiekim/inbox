import fs from "fs";
import path from "path";
import { newTransactionDir, removeTransactionDir } from "server";
import { Literal, MessageLiteral } from "./types";

const MESSAGE_FILE = "message";

export const isMessageLiteral = (literal: Literal): literal is MessageLiteral =>
  typeof literal !== "string";

/** Removes a spooled message literal and the directory it was written into. */
export const removeMessageLiteral = (literal: MessageLiteral): Promise<void> =>
  removeTransactionDir(path.dirname(literal.path));

/** Removes every spooled message literal among `literals`. */
export const removeMessageLiterals = async (literals: readonly Literal[]): Promise<void> => {
  await Promise.all(literals.filter(isMessageLiteral).map(removeMessageLiteral));
};

/**
 * An APPEND message literal written to its own transaction directory as its
 * octets arrive, so a session holds one segment of a message rather than all
 * of it.
 *
 * Every file operation queues behind the previous one, so a `discard` that
 * lands while a write is pending — the socket closing mid-literal — removes
 * the file only after the write settles.
 */
export class LiteralSpool {
  private readonly dir = newTransactionDir();
  private readonly path = path.join(this.dir, MESSAGE_FILE);
  private handle: fs.promises.FileHandle | null = null;
  private written = 0;
  private discarded = false;
  private queue: Promise<void>;

  constructor() {
    this.queue = fs.promises
      .mkdir(this.dir, { recursive: true })
      .then(() => fs.promises.open(this.path, "wx"))
      .then((handle) => {
        this.handle = handle;
      });
    // Surfaced by the next write instead, which the drain awaits.
    this.queue.catch(() => undefined);
  }

  get isDiscarded(): boolean {
    return this.discarded;
  }

  /** Appends `chunk`. The caller must not reuse its memory until this resolves. */
  write(chunk: Uint8Array): Promise<void> {
    const write = this.queue.then(async () => {
      if (this.discarded || !this.handle) return;
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await this.handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
      this.written += chunk.length;
    });
    this.queue = write;
    return write;
  }

  /** Closes the file and answers the literal it holds, or null once discarded. */
  async finish(): Promise<MessageLiteral | null> {
    const finish = this.queue.then(() => this.close());
    this.queue = finish;
    await finish;
    return this.discarded ? null : { path: this.path, size: this.written };
  }

  /** Drops the file, whatever state the spool is in. Idempotent. */
  discard(): Promise<void> {
    this.discarded = true;
    const discard = this.queue
      .catch(() => undefined)
      .then(() => this.close())
      .catch(() => undefined)
      .then(() => removeTransactionDir(this.dir));
    this.queue = discard;
    return discard;
  }

  private async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }
}
