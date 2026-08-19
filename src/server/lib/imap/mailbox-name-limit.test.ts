/**
 * The byte ceiling on a mailbox name (#858).
 *
 * A stored name is a multiplicand of LIST/LSUB matching cost and outlives the
 * command that wrote it, so no per-command cap can bound it. `mailboxes.name`
 * is `VARCHAR(255)`, but Postgres counts that column in characters — 255
 * astral characters are 1020 bytes — and the rejection arrives as a raised
 * error, which answers a generic `NO CREATE failed` and writes the whole
 * name into an ERROR log line.
 *
 * These cases pin the guard in bytes and pin that it runs *before* the DB
 * round-trip: the fake Store records `getUser`, which the command calls only
 * on the path that reaches the repository.
 */

import { describe, it, expect } from "bun:test";
import { createMailbox, renameMailbox } from "./mailbox-ops";
import { Store } from "./store";
import type { SignedUser } from "common";

const LIMIT = 255;
const ASTRAL = "\u{1F600}"; // 4 UTF-8 bytes, 2 UTF-16 code units

interface Probe {
  store: Store;
  reachedRepository: () => boolean;
}

// getUser is the first thing both commands do once past the guards, and the
// only Store call standing before the repository — so recording it reports
// whether the name reached Postgres. It throws so the DB is never dialled;
// the command's own catch turns that into the generic failure line.
const probe = (): Probe => {
  let called = false;
  const store = {
    getUser: (): SignedUser => {
      called = true;
      throw new Error("probe: the name reached the repository path");
    },
  } as unknown as Store;
  return { store, reachedRepository: () => called };
};

const run = async (
  op: (store: Store, write: (data: string) => boolean) => Promise<void>
): Promise<{ lines: string[]; reachedRepository: boolean }> => {
  const { store, reachedRepository } = probe();
  const lines: string[] = [];
  await op(store, (data: string) => {
    lines.push(data);
    return true;
  });
  return { lines, reachedRepository: reachedRepository() };
};

const create = (name: string) =>
  run((store, write) => createMailbox("A1", name, store, write));

const rename = (target: string) =>
  run((store, write) => renameMailbox("A1", "Archive", target, store, write));

const REFUSAL = `A1 NO [LIMIT] Mailbox name exceeds ${LIMIT} bytes\r\n`;
const CREATE_REACHED = "A1 NO CREATE failed\r\n";
const RENAME_REACHED = "A1 NO RENAME failed\r\n";

describe("CREATE mailbox-name byte ceiling", () => {
  it("accepts a name of exactly the ceiling", async () => {
    const { lines, reachedRepository } = await create("a".repeat(LIMIT));
    expect(lines).toEqual([CREATE_REACHED]);
    expect(reachedRepository).toBe(true);
  });

  it("refuses one byte over, without a DB round-trip", async () => {
    const { lines, reachedRepository } = await create("a".repeat(LIMIT + 1));
    expect(lines).toEqual([REFUSAL]);
    expect(reachedRepository).toBe(false);
  });

  it("counts UTF-8 bytes, not code units", async () => {
    // 64 astral characters are 128 UTF-16 code units — far under a
    // `name.length` cap — but 256 bytes on the wire and in the column.
    const overByBytes = ASTRAL.repeat(64);
    expect(overByBytes.length).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(overByBytes, "utf8")).toBe(LIMIT + 1);

    const over = await create(overByBytes);
    expect(over.lines).toEqual([REFUSAL]);
    expect(over.reachedRepository).toBe(false);

    const under = await create(ASTRAL.repeat(63));
    expect(under.lines).toEqual([CREATE_REACHED]);
    expect(under.reachedRepository).toBe(true);
  });

  it("measures the name the server stores, not the quoted argument", async () => {
    // The surrounding quotes are stripped before the guard, so a quoted name
    // of exactly the ceiling is 257 bytes on the wire and still legal.
    const { lines, reachedRepository } = await create(`"${"a".repeat(LIMIT)}"`);
    expect(lines).toEqual([CREATE_REACHED]);
    expect(reachedRepository).toBe(true);
  });
});

describe("RENAME mailbox-name byte ceiling", () => {
  it("accepts a target of exactly the ceiling", async () => {
    const { lines, reachedRepository } = await rename("a".repeat(LIMIT));
    expect(lines).toEqual([RENAME_REACHED]);
    expect(reachedRepository).toBe(true);
  });

  it("refuses an over-length target, so the ceiling cannot be renamed past", async () => {
    const { lines, reachedRepository } = await rename("a".repeat(LIMIT + 1));
    expect(lines).toEqual([REFUSAL]);
    expect(reachedRepository).toBe(false);
  });

  it("counts UTF-8 bytes on the target too", async () => {
    const { lines, reachedRepository } = await rename(ASTRAL.repeat(64));
    expect(lines).toEqual([REFUSAL]);
    expect(reachedRepository).toBe(false);
  });
});
