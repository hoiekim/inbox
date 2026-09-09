import { describe, it, expect } from "bun:test";
import { validatePushSubscription } from "./push-validation";

const FCM_ENDPOINT = "https://fcm.googleapis.com/fcm/send/f4Kx9";

const withEndpoint = (endpoint: unknown) => ({
  endpoint,
  keys: { p256dh: "BNc...p256dh", auth: "Yy8...auth" },
});

const expectRejected = (input: unknown, reason?: RegExp) => {
  const result = validatePushSubscription(input);
  expect(result.valid).toBe(false);
  const rejection = result as { valid: false; message: string };
  if (reason) expect(rejection.message).toMatch(reason);
  return rejection;
};

const NOT_AN_IP = /not by IP/;
const NOT_QUALIFIED = /fully qualified hostname/;
const NOT_INTERNAL = /internal hostname/;

const expectAccepted = (input: unknown) => {
  const result = validatePushSubscription(input);
  expect(result).toEqual({
    valid: true,
    subscription: {
      endpoint: FCM_ENDPOINT,
      keys: { p256dh: "BNc...p256dh", auth: "Yy8...auth" },
    },
  });
};

describe("validatePushSubscription", () => {
  it("accepts a push service subscription and returns the narrowed value", () => {
    expectAccepted(withEndpoint(FCM_ENDPOINT));
  });

  it("keeps only endpoint and keys, dropping any other caller-supplied field", () => {
    const result = validatePushSubscription({
      ...withEndpoint(FCM_ENDPOINT),
      expirationTime: 1,
      proxy: "http://attacker.example",
    });

    expect(result.valid).toBe(true);
    expect(Object.keys((result as { subscription: object }).subscription).sort()).toEqual([
      "endpoint",
      "keys",
    ]);
  });

  describe("endpoint scheme", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/f4Kx9",
      "file:///etc/passwd",
      "gopher://fcm.googleapis.com/",
    ]) {
      it(`rejects ${endpoint}`, () => {
        expectRejected(withEndpoint(endpoint), /must use https/);
      });
    }

    for (const endpoint of ["//fcm.googleapis.com/fcm/send/f4Kx9", "fcm.googleapis.com/fcm/send/f4Kx9"]) {
      it(`rejects unparseable ${endpoint}`, () => {
        expectRejected(withEndpoint(endpoint), /valid URL/);
      });
    }
  });

  describe("internal destinations", () => {
    // Each case is paired with the rule that must reject it, so a case caught
    // by the wrong rule fails rather than passing on the verdict alone. The
    // bracketed IPv6 and numeric IPv4 rows are what a prefix denylist written
    // against the raw input reads past: `new URL` reports them as "[::1]" and
    // "127.0.0.1", matching neither "::1" nor a "127."-prefixed literal.
    for (const [endpoint, reason] of [
      ["https://127.0.0.1/push", NOT_AN_IP],
      ["https://127.0.0.1:6379/push", NOT_AN_IP],
      ["https://2130706433/push", NOT_AN_IP],
      ["https://0x7f000001/push", NOT_AN_IP],
      ["https://127.1/push", NOT_AN_IP],
      ["https://0177.0.0.1/push", NOT_AN_IP],
      ["https://127.0.0.1./push", NOT_AN_IP],
      ["https://[::1]/push", NOT_AN_IP],
      ["https://[0:0:0:0:0:0:0:1]/push", NOT_AN_IP],
      ["https://[::ffff:127.0.0.1]/push", NOT_AN_IP],
      ["https://[fd00::1]/push", NOT_AN_IP],
      ["https://[fe80::1]/push", NOT_AN_IP],
      ["https://10.0.0.1/push", NOT_AN_IP],
      ["https://172.16.0.1/push", NOT_AN_IP],
      ["https://192.168.1.1/push", NOT_AN_IP],
      ["https://169.254.169.254/latest/meta-data/", NOT_AN_IP],
      ["https://100.100.100.200/push", NOT_AN_IP],
      ["https://localhost/push", NOT_QUALIFIED],
      ["https://localhost./push", NOT_QUALIFIED],
      ["https://redis/push", NOT_QUALIFIED],
      ["https://metadata.google.internal/computeMetadata/v1/", NOT_INTERNAL],
      ["https://metadata.google.internal./computeMetadata/v1/", NOT_INTERNAL],
      ["https://db.internal/push", NOT_INTERNAL],
      ["https://printer.local/push", NOT_INTERNAL],
      ["https://host.home.arpa/push", NOT_INTERNAL],
      ["https://api.localhost/push", NOT_INTERNAL],
    ] as [string, RegExp][]) {
      it(`rejects ${endpoint}`, () => {
        expectRejected(withEndpoint(endpoint), reason);
      });
    }
  });

  it("rejects an endpoint carrying credentials", () => {
    expectRejected(withEndpoint("https://user:pass@fcm.googleapis.com/fcm/send/f4Kx9"), /credentials/);
  });

  it("rejects an endpoint longer than the stored column should carry", () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${"a".repeat(2048)}`;
    const { message } = expectRejected(withEndpoint(endpoint));
    expect(message).toMatch(/2048/);
  });

  describe("body shape", () => {
    for (const [name, input] of [
      ["undefined", undefined],
      ["null", null],
      ["a string", "https://fcm.googleapis.com/fcm/send/f4Kx9"],
      ["an array", [FCM_ENDPOINT]],
      ["a missing endpoint", { keys: { p256dh: "p", auth: "a" } }],
      ["a non-string endpoint", withEndpoint(42)],
      ["an empty endpoint", withEndpoint("")],
      ["missing keys", { endpoint: FCM_ENDPOINT }],
      ["null keys", { endpoint: FCM_ENDPOINT, keys: null }],
      ["array keys", { endpoint: FCM_ENDPOINT, keys: ["p", "a"] }],
      ["a missing p256dh", { endpoint: FCM_ENDPOINT, keys: { auth: "a" } }],
      ["a missing auth", { endpoint: FCM_ENDPOINT, keys: { p256dh: "p" } }],
      ["a non-string auth", { endpoint: FCM_ENDPOINT, keys: { p256dh: "p", auth: 7 } }],
      ["an empty p256dh", { endpoint: FCM_ENDPOINT, keys: { p256dh: "", auth: "a" } }],
      [
        "an over-long p256dh",
        { endpoint: FCM_ENDPOINT, keys: { p256dh: "p".repeat(257), auth: "a" } },
      ],
    ] as [string, unknown][]) {
      it(`rejects ${name}`, () => {
        expectRejected(input);
      });
    }
  });

  it("accepts the other major push services", () => {
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QF1r0",
      "https://sfo.notify.windows.com/w/?token=Ab3",
    ]) {
      expect(validatePushSubscription(withEndpoint(endpoint)).valid).toBe(true);
    }
  });
});
