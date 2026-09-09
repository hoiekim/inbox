import { describe, it, expect } from "bun:test";
import { MailHeaderData } from "common";
import { Category } from "client";
import { isSentMail, canMarkSpam } from "./mails";

const makeMail = (fromAddress: string | undefined, sent = false) =>
  new MailHeaderData({
    from: fromAddress ? { value: [{ address: fromAddress }], text: fromAddress } : undefined,
    sent,
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
  // Delivered over MX, so the server wrote sent = FALSE, but the unauthenticated
  // `From` header names the user's own domain.
  const spoofed = makeMail(`billing@${DOMAIN}`, false);
  // The user's own outbound copy, addressed to themselves.
  const selfAddressed = makeMail(`hoie@${DOMAIN}`, true);
  const outsider = makeMail("bad@spamtest.example", false);

  it("offers the toggle on a forged own-domain sender in every view", () => {
    const all = Object.values(Category);
    expect(all.map((c) => canMarkSpam(spoofed, c))).toEqual(all.map(() => true));
  });

  it("withholds the toggle on the user's own outbound mail outside the spam view", () => {
    const others = Object.values(Category).filter((c) => c !== Category.SpamMails);
    expect(others.map((c) => canMarkSpam(selfAddressed, c))).toEqual(
      others.map(() => false)
    );
  });

  it("offers the toggle on an outside sender in every view", () => {
    const all = Object.values(Category);
    expect(all.map((c) => canMarkSpam(outsider, c))).toEqual(all.map(() => true));
  });

  it("offers the toggle in the spam view even when the payload omits sent", () => {
    expect(canMarkSpam(new MailHeaderData(), Category.SpamMails)).toBe(true);
  });

  it("pins an explicit answer for every category, so a new member is visible here", () => {
    expect(
      Object.fromEntries(
        Object.values(Category).map((c) => [c, canMarkSpam(selfAddressed, c)])
      )
    ).toEqual({
      "New Mails": false,
      "All Mails": false,
      "Saved Mails": false,
      "Sent Mails": false,
      "Spam Mails": true,
      Search: false,
    });
  });
});
