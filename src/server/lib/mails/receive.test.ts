import { describe, it, expect, afterAll, beforeAll } from "bun:test";

import type { IncomingMail, IncomingMailAddress } from "common";
import { validateIncomingMail, addressToUsername, convertMailAddress } from "./receive";

const makeMail = (envelopeTo: { address: string }[]): IncomingMail =>
  ({ envelopeTo } as unknown as IncomingMail);

describe("validateIncomingMail (envelope-to gate via isValidAddress)", () => {
  it("accepts an exact-match domain recipient", () => {
    const mail = makeMail([{ address: "alice@hoie.kim" }]);
    expect(validateIncomingMail(mail, "hoie.kim")).toBe(mail);
  });

  it("accepts a subdomain recipient", () => {
    const mail = makeMail([{ address: "alice@support.hoie.kim" }]);
    expect(validateIncomingMail(mail, "hoie.kim")).toBe(mail);
  });

  it("rejects an unrelated domain", () => {
    const mail = makeMail([{ address: "alice@other.com" }]);
    expect(validateIncomingMail(mail, "hoie.kim")).toBeUndefined();
  });

  it("rejects a confusable domain that only embeds the target as a substring (regression: PR #478-class bug)", () => {
    // "evil-hoie.kim-attack.com" includes the substring "hoie.kim" but is not
    // a subdomain — the prior `.includes()` check accepted it, the suffix
    // check must reject it.
    const mail = makeMail([{ address: "victim@evil-hoie.kim-attack.com" }]);
    expect(validateIncomingMail(mail, "hoie.kim")).toBeUndefined();
  });

  it("rejects a domain that prepends the target without a dot separator", () => {
    const mail = makeMail([{ address: "victim@notthehoie.kim" }]);
    expect(validateIncomingMail(mail, "hoie.kim")).toBeUndefined();
  });

  it("is case-insensitive on both sides", () => {
    const mail = makeMail([{ address: "Alice@SUPPORT.Hoie.Kim" }]);
    expect(validateIncomingMail(mail, "HOIE.KIM")).toBe(mail);
  });

  it("returns undefined when envelopeTo is missing", () => {
    expect(validateIncomingMail({} as IncomingMail, "hoie.kim")).toBeUndefined();
  });

  it("returns undefined when domainName is missing", () => {
    const mail = makeMail([{ address: "alice@hoie.kim" }]);
    expect(validateIncomingMail(mail, undefined)).toBeUndefined();
  });

  it("accepts the mail when at least one recipient matches", () => {
    const mail = makeMail([
      { address: "victim@evil-hoie.kim-attack.com" },
      { address: "alice@hoie.kim" },
    ]);
    expect(validateIncomingMail(mail, "hoie.kim")).toBe(mail);
  });
});

describe("addressToUsername", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  beforeAll(() => {
    process.env.EMAIL_DOMAIN = "hoie.kim";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("returns the subdomain as the username", () => {
    expect(addressToUsername("anything@bob.hoie.kim")).toBe("bob");
  });

  it("returns 'admin' when the address is at the base domain", () => {
    expect(addressToUsername("hi@hoie.kim")).toBe("admin");
  });
});

// Regression guard for #528: `saveIncomingMail` now builds the spam
// `EmailContext` from the normalized `convertMail` output instead of
// re-implementing the single-vs-array address unwrap inline. The spam check
// reads:
//
//   fromAddress:    mail.from?.value?.[0]?.address
//   fromName:       mail.from?.text
//   replyToAddress: mail.replyTo?.value?.[0]?.address
//
// where `mail.from = convertMailAddress(incoming.from)` and
// `mail.replyTo = convertMailAddress(incoming.replyTo)`. So these assertions
// test the exact pure normalization the spam inputs depend on — locking in the
// single/array unwrap, the address lowercasing, and the joined `text` so a
// change to the normalization can't silently regress the spam check.
//
// `convertMailAddress` is pure (no DB / pool), so there's no mock surface here.

// Mirror of saveIncomingMail's spam-context extraction.
const extract = (from?: IncomingMailAddress | IncomingMailAddress[], replyTo?: IncomingMailAddress | IncomingMailAddress[]) => {
  const f = convertMailAddress(from);
  const r = convertMailAddress(replyTo);
  return {
    fromAddress: f?.value?.[0]?.address,
    fromName: f?.text,
    replyToAddress: r?.value?.[0]?.address,
  };
};

describe("convertMailAddress (spam EmailContext source, #528)", () => {
  it("normalizes a single-object address: lowercases the address, preserves text", () => {
    const result = convertMailAddress({
      value: { address: "Sender@Example.COM", name: "Sender" },
      text: "Sender <Sender@Example.COM>",
    } as unknown as IncomingMailAddress);
    expect(result?.value?.[0]?.address).toBe("sender@example.com");
    expect(result?.value?.[0]?.name).toBe("Sender");
    expect(result?.text).toBe("Sender <Sender@Example.COM>");
  });

  it("normalizes an array address: first address from the flattened value, text joined with ', '", () => {
    const result = convertMailAddress([
      { value: [{ address: "First@X.com" }], text: "First" },
      { value: [{ address: "Second@Y.com" }], text: "Second" },
    ] as unknown as IncomingMailAddress[]);
    expect(result?.value?.[0]?.address).toBe("first@x.com");
    expect(result?.value?.[1]?.address).toBe("second@y.com");
    expect(result?.text).toBe("First, Second");
  });

  it("returns undefined for missing input", () => {
    expect(convertMailAddress(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(convertMailAddress([])).toBeUndefined();
  });

  it("EmailContext extraction: single from + single replyTo → lowercased addresses", () => {
    expect(
      extract(
        { value: { address: "From@A.com" }, text: "from" } as unknown as IncomingMailAddress,
        { value: { address: "Reply@B.com" }, text: "reply" } as unknown as IncomingMailAddress,
      ),
    ).toEqual({
      fromAddress: "from@a.com",
      fromName: "from",
      replyToAddress: "reply@b.com",
    });
  });

  it("EmailContext extraction: array from + array replyTo → first address of each", () => {
    expect(
      extract(
        [
          { value: [{ address: "F1@A.com" }], text: "f1" },
          { value: [{ address: "F2@A.com" }], text: "f2" },
        ] as unknown as IncomingMailAddress[],
        [
          { value: [{ address: "R1@B.com" }], text: "r1" },
          { value: [{ address: "R2@B.com" }], text: "r2" },
        ] as unknown as IncomingMailAddress[],
      ),
    ).toEqual({
      fromAddress: "f1@a.com",
      fromName: "f1, f2",
      replyToAddress: "r1@b.com",
    });
  });

  it("EmailContext extraction: absent from/replyTo → undefined fields (no crash)", () => {
    expect(extract(undefined, undefined)).toEqual({
      fromAddress: undefined,
      fromName: undefined,
      replyToAddress: undefined,
    });
  });
});
