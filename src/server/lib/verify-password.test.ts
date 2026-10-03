/**
 * The property under test is not "the right password wins" — that one is
 * visible from every caller's own suite. It is that the bcrypt round is spent
 * whether or not the credential being presented resolves to anything, because
 * a round skipped is tens of milliseconds saved, and a caller that saves them
 * tells a remote prober which usernames exist.
 *
 * An assertion on the returned boolean cannot see that: false is false under
 * both implementations. So every case here asserts on the `bcrypt.compare`
 * calls the subject made, not on what it answered.
 */

import { describe, it, expect, mock, afterAll, beforeEach } from "bun:test";
import { restoreLeaves } from "test-helpers";

const realBcrypt = (globalThis as Record<string, unknown>).__REAL_BCRYPT as {
  compare: (password: string, hash: string) => Promise<boolean>;
  hash: (password: string, rounds: number) => Promise<string>;
  default: Record<string, unknown>;
};

/** Every `bcrypt.compare` the subject makes, as `[password, hash]`. */
const compareCalls: [string, string][] = [];

/**
 * Forces the comparison's answer for the one case that needs the real
 * implementation out of the way: a true verdict against the stand-in digest
 * must still not authenticate, and the stand-in's preimage is not ours to know.
 */
let forcedVerdict: boolean | null = null;

const trackedCompare = async (password: string, hash: string) => {
  compareCalls.push([password, hash]);
  const real = await realBcrypt.compare(password, hash);
  return forcedVerdict ?? real;
};

mock.module("bcryptjs", () => ({
  ...realBcrypt,
  compare: trackedCompare,
  default: { ...realBcrypt.default, compare: trackedCompare },
}));

const { verifyPassword } = await import("./verify-password");
const { encryptPassword } = await import("./users");

afterAll(restoreLeaves);

/** A complete bcrypt digest — 22 salt chars plus 31 of hash, base64-ish alphabet. */
const BCRYPT_DIGEST = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** The cost field of a bcrypt digest — `10` out of `$2b$10$…`. */
const costOf = (hash: string) => hash.split("$")[2];

/** Cost 4 keeps fixture digests real without paying the production round. */
const digestOf = (password: string) => realBcrypt.hash(password, 4);

beforeEach(() => {
  compareCalls.length = 0;
  forcedVerdict = null;
});

describe("verifyPassword verdict", () => {
  it("accepts the password that produced the stored digest", async () => {
    expect(await verifyPassword("correct-horse", await digestOf("correct-horse"))).toBe(true);
  });

  it("rejects a different password against the stored digest", async () => {
    expect(await verifyPassword("hunter2", await digestOf("correct-horse"))).toBe(false);
  });

  it("rejects when there is no stored digest", async () => {
    expect(await verifyPassword("hunter2", undefined)).toBe(false);
    expect(await verifyPassword("hunter2", null)).toBe(false);
  });

  it("rejects an empty or absent password against a real digest", async () => {
    const digest = await digestOf("");
    expect(await verifyPassword("", digest)).toBe(false);
    expect(await verifyPassword(undefined, digest)).toBe(false);
  });

  it("refuses a matching comparison when the digest it matched was the stand-in", async () => {
    // Kills the implementation that returns the comparison's verdict directly:
    // the stand-in digest is a published literal, so a caller that trusted a
    // true verdict against it would authenticate anyone who knew its preimage
    // as any username that does not exist.
    forcedVerdict = true;
    expect(await verifyPassword("whatever-the-dummy-hashes", undefined)).toBe(false);
    expect(await verifyPassword("whatever-the-dummy-hashes", null)).toBe(false);
    expect(await verifyPassword("whatever-the-dummy-hashes", "")).toBe(false);
  });
});

describe("verifyPassword cost is independent of whether the account exists", () => {
  it("spends a bcrypt round against a real digest when no digest was stored", async () => {
    await verifyPassword("hunter2", undefined);

    expect(compareCalls).toHaveLength(1);
    const [password, hash] = compareCalls[0]!;
    expect(password).toBe("hunter2");
    expect(hash).toMatch(BCRYPT_DIGEST);
  });

  it("spends a bcrypt round when the stored digest is empty", async () => {
    // bcryptjs answers false for an empty digest without hashing at all —
    // microseconds, not milliseconds — so an empty stored value has to be
    // swapped for the stand-in rather than handed through. `writeUser` hashes
    // every password it stores, so empty and null are the only non-digest
    // values the column can carry.
    await verifyPassword("hunter2", "");

    expect(compareCalls).toHaveLength(1);
    expect(compareCalls[0]![1]).not.toBe("");
    expect(compareCalls[0]![1]).toMatch(BCRYPT_DIGEST);
  });

  it("spends a bcrypt round when no password was submitted either", async () => {
    await verifyPassword(undefined, undefined);

    expect(compareCalls).toHaveLength(1);
    expect(compareCalls[0]![1]).toMatch(BCRYPT_DIGEST);
  });

  it("spends the same number of rounds with and without a stored digest", async () => {
    await verifyPassword("hunter2", await digestOf("correct-horse"));
    const withDigest = compareCalls.length;

    compareCalls.length = 0;
    await verifyPassword("hunter2", undefined);

    expect(withDigest).toBe(1);
    expect(compareCalls).toHaveLength(withDigest);
  });

  it("stands in a digest of the cost the app hashes real passwords at", async () => {
    await verifyPassword("hunter2", undefined);

    // Derived from the app's own hasher rather than written as a literal: a
    // stand-in cheaper than what real accounts carry answers in a fraction of
    // the time and leaves the differential it exists to erase.
    expect(costOf(compareCalls[0]![1])).toBe(costOf(await encryptPassword("x")));
  });

  it("does not stand in a real account's digest", async () => {
    const stored = await digestOf("correct-horse");
    await verifyPassword("hunter2", stored);
    const realDigest = compareCalls[0]![1];

    compareCalls.length = 0;
    await verifyPassword("hunter2", undefined);

    expect(compareCalls[0]![1]).not.toBe(realDigest);
    expect(await realBcrypt.compare("hunter2", compareCalls[0]![1])).toBe(false);
  });
});
