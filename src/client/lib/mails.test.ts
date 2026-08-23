import { describe, it, expect } from "bun:test";
import { MailHeaderData } from "common";
import { Category } from "client";
import { isSentMail, canMarkSpam } from "./mails";

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

describe("canMarkSpam", () => {
  const DOMAIN = "hoie.kim";
  const spoofed = makeMail("billing@hoie.kim");
  const outsider = makeMail("bad@spamtest.example");

  const RECEIVED_ONLY = [Category.NewMails, Category.AllMails, Category.SpamMails];
  const MIXED = [Category.SavedMails, Category.Search];

  it("offers the toggle on a forged own-domain sender in every received-only view", () => {
    expect(RECEIVED_ONLY.map((c) => canMarkSpam(spoofed, DOMAIN, c))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("treats a forged own-domain sender the same as an outside sender there", () => {
    for (const category of RECEIVED_ONLY) {
      expect(canMarkSpam(spoofed, DOMAIN, category)).toBe(
        canMarkSpam(outsider, DOMAIN, category)
      );
    }
  });

  it("never offers the toggle in the Sent view", () => {
    expect(canMarkSpam(outsider, DOMAIN, Category.SentMails)).toBe(false);
    expect(canMarkSpam(spoofed, DOMAIN, Category.SentMails)).toBe(false);
  });

  it("falls back to the sender address in the views that match both sides", () => {
    expect(MIXED.map((c) => canMarkSpam(spoofed, DOMAIN, c))).toEqual([false, false]);
    expect(MIXED.map((c) => canMarkSpam(outsider, DOMAIN, c))).toEqual([true, true]);
  });

  it("offers the toggle when the sender address is missing", () => {
    expect(canMarkSpam(makeMail(undefined), DOMAIN, Category.AllMails)).toBe(true);
    expect(canMarkSpam(makeMail(undefined), DOMAIN, Category.SavedMails)).toBe(true);
  });
});
