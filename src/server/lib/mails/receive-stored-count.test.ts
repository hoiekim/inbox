/**
 * `saveMailHandler` answers how many mailboxes it wrote, and the SMTP handler
 * turns a zero into a transient refusal rather than a `250`. The property is
 * "the count is writes, not recipients" — a count of recipients answers `250`
 * for a message nothing was stored for, which is the acceptance the envelope
 * gate exists to prevent.
 *
 * A recipient inside the served zone that owns no account returns from
 * `saveIncomingMail` at its own `if (!user)` guard, before anything touches the
 * pool, so stubbing `getUser` is the whole harness.
 */
import { describe, it, expect, mock, afterAll } from "bun:test";
import type { IncomingMail } from "common";

const REAL_SERVER = (globalThis as Record<string, unknown>).__REAL_SERVER as Record<
  string,
  unknown
>;

const mockGetUser = mock(async () => undefined);

mock.module("server", () => ({
  ...REAL_SERVER,
  getUser: mockGetUser,
}));

const { saveMailHandler } = await import("./receive");

// `mock.module` is process-global with no unmock API — hand the real module
// back so the next file in the same run does not inherit this stub.
afterAll(() => {
  if (REAL_SERVER) mock.module("server", () => REAL_SERVER);
});

const makeMail = (addresses: string[]): IncomingMail =>
  ({ envelopeTo: addresses.map((address) => ({ address })) } as unknown as IncomingMail);

describe("saveMailHandler stored count", () => {
  const originalEnv = process.env;

  it("answers 0 when every local recipient owns no account", async () => {
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
    mockGetUser.mockClear();

    const stored = await saveMailHandler(
      null,
      makeMail(["x@ghost1.test.com", "y@ghost2.test.com"])
    );

    expect(stored).toBe(0);
    expect(mockGetUser).toHaveBeenCalledTimes(2);
    process.env = originalEnv;
  });

  it("answers 0 when no recipient is inside the served zone", async () => {
    process.env = { ...originalEnv, EMAIL_DOMAIN: "test.com" };
    mockGetUser.mockClear();

    const stored = await saveMailHandler(null, makeMail(["someone@other.com"]));

    expect(stored).toBe(0);
    expect(mockGetUser).not.toHaveBeenCalled();
    process.env = originalEnv;
  });
});
