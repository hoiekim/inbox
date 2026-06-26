import { describe, it, expect } from "bun:test";
import { Category } from "client";
import { getMailsQueryUrl } from "./index";

describe("getMailsQueryUrl", () => {
  it("routes Spam to the user-global spam endpoint, ignoring the account", () => {
    // Spam is not account-scoped: the account argument must not leak into the URL.
    expect(getMailsQueryUrl("alice@x.com", Category.SpamMails)).toBe(
      "/api/mails/spam"
    );
    expect(getMailsQueryUrl("", Category.SpamMails)).toBe("/api/mails/spam");
  });

  it("routes the account-scoped categories to /headers with the right flag", () => {
    expect(getMailsQueryUrl("alice@x.com", Category.AllMails)).toBe(
      "/api/mails/headers/alice@x.com"
    );
    expect(getMailsQueryUrl("alice@x.com", Category.NewMails)).toBe(
      "/api/mails/headers/alice@x.com?new=1"
    );
    expect(getMailsQueryUrl("alice@x.com", Category.SentMails)).toBe(
      "/api/mails/headers/alice@x.com?sent=1"
    );
    expect(getMailsQueryUrl("alice@x.com", Category.SavedMails)).toBe(
      "/api/mails/headers/alice@x.com?saved=1"
    );
  });

  it("routes Search to the encoded search endpoint", () => {
    expect(getMailsQueryUrl("a b@x.com", Category.Search)).toBe(
      "/api/mails/search/a%20b%40x.com"
    );
  });
});
