import { describe, it, expect, afterAll, beforeAll } from "bun:test";

import type { IncomingMail } from "common";
import { validateIncomingMail, addressToUsername } from "./receive";

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
