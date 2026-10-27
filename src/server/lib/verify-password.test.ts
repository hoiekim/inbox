/**
 * The property under test is not "the right password wins" — that one is
 * visible from every caller's own suite. It is that the bcrypt round is spent
 * whether or not the credential being presented resolves to anything, because
 * a round skipped is tens of milliseconds saved, and a caller that saves them
 * tells a remote prober which usernames exist.
 *
 * An assertion on the returned boolean cannot see that: false is false under
 * both implementations. So every case here asserts on the `Bun.password.verify`
 * calls the subject made, not on what it answered.
 */

import { describe, it, expect, afterAll, beforeEach, spyOn } from "bun:test";

const realVerify = Bun.password.verify.bind(Bun.password);

/** Every `Bun.password.verify` the subject makes, as `[password, hash]`. */
const compareCalls: [string, string][] = [];

/**
 * Forces the comparison's answer for the one case that needs the real
 * implementation out of the way: a true verdict against the stand-in digest
 * must still not authenticate, and the stand-in's preimage is not ours to know.
 */
let forcedVerdict: boolean | null = null;

const verifySpy = spyOn(Bun.password, "verify").mockImplementation(async (password, hash) => {
  const text = typeof password === "string" ? password : new TextDecoder().decode(password as Uint8Array);
  compareCalls.push([text, hash]);
  const real = await realVerify(password, hash);
  return forcedVerdict ?? real;
});

const { verifyPassword, hashPassword } = await import("./verify-password");
const { encryptPassword } = await import("./users");

afterAll(() => verifySpy.mockRestore());

/** A complete bcrypt digest — 22 salt chars plus 31 of hash, base64-ish alphabet. */
const BCRYPT_DIGEST = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** The cost field of a bcrypt digest — `10` out of `$2b$10$…`. */
const costOf = (hash: string) => hash.split("$")[2];

/** Cost 4 keeps fixture digests real without paying the production round. */
const digestOf = (password: string) =>
  Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });

/** A cost-4 digest of the empty string, which `Bun.password.hash` refuses to produce. */
const EMPTY_PASSWORD_DIGEST = "$2b$04$1ZJlW09Oj.28Pc9tQVIVleBOo11ISY6Ra1sWrn.NHENatHa9CdAz6";

/** A 91-byte password: bcrypt reads only its first 72 bytes. */
const OVER_72_BYTES = "pässwörd-longer-than-seventy-two-bytes-" + "x".repeat(50);

/**
 * Digests made by bcryptjs, a truncating bcrypt implementation, in both the
 * `$2a$` and `$2b$` variants.
 */
const STORED_DIGESTS = {
  "correct-horse": "$2b$10$39XnZ0siZCL6PF2Tyd9hQOUpJZ0UXyjcT.i8Bux3S7ZCsJLH7aKRK",
  "legacy-2a": "$2a$10$4u/C0mkCyaoAyjIhZsQJi.Tq.OKFOwJ9VRgVYpqKoy4Y/Xd9Suw2S",
  [OVER_72_BYTES]: "$2b$10$fmlDOB6PWM2KHYQAIiyoteRVvXG3fvj38TNw.u30ERUtBiIpIvJA.",
};

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
    expect(await verifyPassword("", EMPTY_PASSWORD_DIGEST)).toBe(false);
    expect(await verifyPassword(undefined, EMPTY_PASSWORD_DIGEST)).toBe(false);
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
    // An empty digest is answered without hashing at all — microseconds, not
    // milliseconds — so an empty stored value has to be
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
    expect(await realVerify("hunter2", compareCalls[0]![1])).toBe(false);
  });
});

describe("verifyPassword accepts digests made by a truncating bcrypt implementation", () => {
  for (const [password, digest] of Object.entries(STORED_DIGESTS)) {
    it(`accepts ${digest.slice(0, 7)} digest of a ${new TextEncoder().encode(password).length}-byte password`, async () => {
      expect(await verifyPassword(password, digest)).toBe(true);
      expect(await verifyPassword(`${password}-wrong`.slice(1), digest)).toBe(false);
    });
  }

  it("reads only the first 72 bytes of a long password, as a truncating bcrypt hashed it", async () => {
    const digest = STORED_DIGESTS[OVER_72_BYTES];
    const samePrefix = new TextDecoder().decode(new TextEncoder().encode(OVER_72_BYTES).slice(0, 72));
    expect(await verifyPassword(samePrefix, digest)).toBe(true);
    expect(await verifyPassword(`${samePrefix}different tail`, digest)).toBe(true);
    expect(await verifyPassword(samePrefix.slice(0, -1), digest)).toBe(false);
  });

  it("answers false rather than throwing for a stored value that is not a digest", async () => {
    expect(await verifyPassword("hunter2", "not-a-digest")).toBe(false);
  });
});

describe("hashPassword", () => {
  it("writes a $2b$ bcrypt digest at cost 10, so an older build can still verify it", async () => {
    const digest = await hashPassword("correct-horse");
    expect(digest).toMatch(BCRYPT_DIGEST);
    expect(digest.slice(0, 7)).toBe("$2b$10$");
    expect(await verifyPassword("correct-horse", digest)).toBe(true);
  });

  it("hashes only the first 72 bytes of a long password", async () => {
    const digest = await hashPassword(OVER_72_BYTES);
    const prefix = new TextEncoder().encode(OVER_72_BYTES).slice(0, 72);
    expect(await realVerify(prefix, digest)).toBe(true);
    expect(await verifyPassword(OVER_72_BYTES, digest)).toBe(true);
  });
});
