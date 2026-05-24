import { describe, it, expect } from "bun:test";
import { MailHeaderData } from "common";
import { isSentMail } from "./mails";

const makeMail = (fromAddress: string | undefined) =>
  new MailHeaderData({
    from: fromAddress ? { value: [{ address: fromAddress }], text: fromAddress } : undefined,
  });

describe("isSentMail", () => {
  it("returns true when sender address ends with @<userDomain>", () => {
    expect(isSentMail(makeMail("hoie@hoie.kim"), "hoie.kim")).toBe(true);
    expect(isSentMail(makeMail("career@hoie.kim"), "hoie.kim")).toBe(true);
  });

  it("returns false when sender address is on a different domain", () => {
    expect(isSentMail(makeMail("eric.cole@salesforce.com"), "hoie.kim")).toBe(false);
    expect(isSentMail(makeMail("noreply@github.com"), "hoie.kim")).toBe(false);
  });

  it("is case-insensitive on both sender address and domain", () => {
    expect(isSentMail(makeMail("Hoie@Hoie.Kim"), "hoie.kim")).toBe(true);
    expect(isSentMail(makeMail("hoie@hoie.kim"), "HOIE.KIM")).toBe(true);
  });

  it("does not substring-match a domain that merely contains the user domain", () => {
    // e.g. user domain "hoie.kim" must not match "hoie.kim.attacker.com"
    expect(isSentMail(makeMail("phish@hoie.kim.attacker.com"), "hoie.kim")).toBe(false);
    // …and must not match "fakehoie.kim" (no @ boundary)
    expect(isSentMail(makeMail("phish@fakehoie.kim"), "hoie.kim")).toBe(false);
  });

  it("returns false when from address or user domain is missing", () => {
    expect(isSentMail(makeMail(undefined), "hoie.kim")).toBe(false);
    expect(isSentMail(makeMail("hoie@hoie.kim"), "")).toBe(false);
    expect(isSentMail({ from: { value: [], text: "" } }, "hoie.kim")).toBe(false);
  });
});
