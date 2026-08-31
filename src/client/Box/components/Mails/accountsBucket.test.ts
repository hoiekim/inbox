import { describe, it, expect } from "bun:test";
import { Account, MailHeaderData } from "common";
import { Category } from "client";
import {
  bucketsForCategory,
  bucketsForMail,
  evictAccountFromCategory,
  listsWholeBucket,
  removeAccountFromBucket,
  updateAccountInBucket,
  updateAccountInBuckets
} from "./accountsBucket";

const makeAccount = (key: string, doc = 5, unread = 2, saved = 1) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: doc,
    unread_doc_count: unread,
    saved_doc_count: saved
  });

const data = () => ({
  received: [makeAccount("me@x.com"), makeAccount("other@x.com")],
  sent: [makeAccount("me@x.com")],
  spam: [makeAccount("spammy@x.com")]
});

const addresses = (...values: string[]) => ({
  value: values.map((address) => ({ address })),
  text: values.join(", ")
});

const mail = (parts: Partial<MailHeaderData>) => new MailHeaderData(parts);

describe("bucketsForCategory", () => {
  it("names the lists each category draws its mail from", () => {
    expect(bucketsForCategory(Category.SentMails)).toEqual(["sent"]);
    expect(bucketsForCategory(Category.SpamMails)).toEqual(["spam"]);
    expect(bucketsForCategory(Category.AllMails)).toEqual(["received"]);
    expect(bucketsForCategory(Category.NewMails)).toEqual(["received"]);
  });

  it("names both lists for Saved Mails and none for Search", () => {
    expect(bucketsForCategory(Category.SavedMails)).toEqual([
      "received",
      "sent"
    ]);
    expect(bucketsForCategory(Category.Search)).toEqual([]);
  });
});

describe("bucketsForMail", () => {
  const sentByMe = mail({
    from: addresses("me@x.com"),
    to: addresses("them@y.com")
  });
  const sentToMe = mail({
    from: addresses("them@y.com"),
    to: addresses("me@x.com")
  });

  it("follows the addresses under every category that counts them", () => {
    expect(bucketsForMail(Category.SentMails, sentByMe, "me@x.com")).toEqual([
      "sent"
    ]);
    expect(bucketsForMail(Category.SentMails, sentToMe, "me@x.com")).toEqual([
      "received"
    ]);
    expect(bucketsForMail(Category.NewMails, sentToMe, "me@x.com")).toEqual([
      "received"
    ]);
  });

  // The spam folder is `is_spam = TRUE`, and both counted lists are its
  // complement, so a mail acted on there reaches neither of them.
  it("names the spam list alone under Spam Mails", () => {
    expect(bucketsForMail(Category.SpamMails, sentToMe, "me@x.com")).toEqual([
      "spam"
    ]);
    expect(
      bucketsForMail(Category.SpamMails, sentByMe, "me@x.com")
    ).toEqual(["spam"]);
  });

  // `selectedAccount` holds the live search term there, and the search query
  // applies no address, sent or spam condition — so no account's counters
  // follow from a row being listed.
  it("names no list under Search", () => {
    expect(bucketsForMail(Category.Search, sentToMe, "me@x.com")).toEqual([]);
  });

  // Saved Mails lists `(from_address matches OR a recipient matches)`, and the
  // server groups `sent` by the sender and `received` by the recipients, so an
  // address that only ever sent is counted in `sent` alone.
  it("follows the addresses under Saved Mails", () => {
    expect(bucketsForMail(Category.SavedMails, sentByMe, "me@x.com")).toEqual([
      "sent"
    ]);
    expect(bucketsForMail(Category.SavedMails, sentToMe, "me@x.com")).toEqual([
      "received"
    ]);
  });

  it("counts a mail an account both sent and received in both lists", () => {
    const toSelf = mail({
      from: addresses("me@x.com"),
      to: addresses("me@x.com")
    });
    expect(bucketsForMail(Category.SavedMails, toSelf, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
  });

  // A star applied in one list and removed from another has to cancel: the
  // counters the edits reach are the server's, and it groups the same row into
  // both lists regardless of which view the user was in.
  it("answers the same lists for one mail across every category listing it", () => {
    const ccSelf = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      cc: addresses("me@x.com")
    });
    const both = ["received", "sent"];
    expect(bucketsForMail(Category.AllMails, ccSelf, "me@x.com")).toEqual(both);
    expect(bucketsForMail(Category.NewMails, ccSelf, "me@x.com")).toEqual(both);
    expect(bucketsForMail(Category.SavedMails, ccSelf, "me@x.com")).toEqual(
      both
    );
    expect(bucketsForMail(Category.SentMails, ccSelf, "me@x.com")).toEqual(
      both
    );
  });

  // The received condition covers `envelope_to`, which no header column
  // carries, so a category that lists received mail is the only evidence that
  // a mail the account also sent reached its received counters.
  it("reads a category listing received mail as proof of the received side", () => {
    expect(bucketsForMail(Category.AllMails, sentByMe, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
    expect(bucketsForMail(Category.SavedMails, sentByMe, "me@x.com")).toEqual([
      "sent"
    ]);
  });

  // Copying yourself on your own mail is the case the recipient headers decide
  // on their own: the sender test already answers `sent`, so `received` is
  // reached only if cc and bcc count alongside `to`.
  it("reads cc and bcc as recipients", () => {
    const cced = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      cc: addresses("me@x.com")
    });
    const bcced = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      bcc: addresses("me@x.com")
    });
    expect(bucketsForMail(Category.SavedMails, cced, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
    expect(bucketsForMail(Category.SavedMails, bcced, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
  });

  // `envelope_to` matches the received condition on the server and is absent
  // from the header payload, so a row the account did not send is received
  // whether or not a visible recipient header names it.
  it("reads a mail it did not send as received under Saved Mails", () => {
    const envelopeOnly = mail({
      from: addresses("them@y.com"),
      to: addresses("list@y.com")
    });
    expect(
      bucketsForMail(Category.SavedMails, envelopeOnly, "me@x.com")
    ).toEqual(["received"]);
  });

  // The header component repairs cc and bcc in place during render, so a click
  // handler reading the same object sees an array only because an unrelated
  // component ran first.
  it("reads a recipient field the payload delivered unwrapped", () => {
    const unwrappedCc = mail({
      from: addresses("them@y.com"),
      to: addresses("them@y.com"),
      cc: { value: { address: "me@x.com" }, text: "me@x.com" }
    } as unknown as Partial<MailHeaderData>);
    expect(bucketsForMail(Category.SavedMails, unwrappedCc, "me@x.com")).toEqual(
      ["received"]
    );
    const unwrappedFrom = mail({
      from: { value: { address: "me@x.com" }, text: "me@x.com" },
      to: addresses("them@y.com")
    } as unknown as Partial<MailHeaderData>);
    expect(
      bucketsForMail(Category.SentMails, unwrappedFrom, "me@x.com")
    ).toEqual(["sent"]);
  });

  it("ignores the sent flag, which names the user rather than the address", () => {
    const fromMyOtherAddress = mail({
      sent: true,
      from: addresses("alias@x.com"),
      to: addresses("me@x.com")
    });
    expect(
      bucketsForMail(Category.SavedMails, fromMyOtherAddress, "me@x.com")
    ).toEqual(["received"]);
  });
});

describe("listsWholeBucket", () => {
  it("is true for the categories that list a bucket whole", () => {
    expect(listsWholeBucket(Category.AllMails)).toBe(true);
    expect(listsWholeBucket(Category.SentMails)).toBe(true);
    expect(listsWholeBucket(Category.SpamMails)).toBe(true);
  });

  // New Mails and Saved Mails filter `received` by a counter, so an emptied
  // list there says the counter hit zero, not that the account left `received`.
  it("is false for the counter-filtered views and Search", () => {
    expect(listsWholeBucket(Category.NewMails)).toBe(false);
    expect(listsWholeBucket(Category.SavedMails)).toBe(false);
    expect(listsWholeBucket(Category.Search)).toBe(false);
  });
});

describe("updateAccountInBucket", () => {
  it("applies the update to the matching account", () => {
    const next = updateAccountInBucket(
      data(),
      "received",
      "me@x.com",
      ({ unread_doc_count }) => ({ unread_doc_count: unread_doc_count - 1 })
    );
    expect(next.received.map((a) => a.unread_doc_count)).toEqual([1, 2]);
  });

  // react-query keeps the previous `data` reference when structural sharing
  // finds every element reference-equal, so a mutated account notifies no
  // observer and the sidebar renders the stale count.
  it("replaces the account rather than mutating it", () => {
    const before = data();
    const next = updateAccountInBucket(before, "received", "me@x.com", () => ({
      doc_count: 0
    }));
    expect(before.received[0].doc_count).toBe(5);
    expect(next.received[0]).not.toBe(before.received[0]);
    expect(next.received).not.toBe(before.received);
    expect(next).not.toBe(before);
  });

  it("leaves the untouched accounts and the other buckets reference-equal", () => {
    const before = data();
    const next = updateAccountInBucket(before, "received", "me@x.com", () => ({
      doc_count: 0
    }));
    expect(next.received[1]).toBe(before.received[1]);
    expect(next.sent).toBe(before.sent);
    expect(next.spam).toBe(before.spam);
  });

  it("returns an Account, not a bare object", () => {
    const next = updateAccountInBucket(data(), "sent", "me@x.com", () => ({
      doc_count: 1
    }));
    expect(next.sent[0]).toBeInstanceOf(Account);
    expect(next.sent[0].key).toBe("me@x.com");
    expect(next.sent[0].updated).toEqual(new Date("2026-01-01"));
  });

  it("no-ops when the key is in a different bucket", () => {
    const before = data();
    const next = updateAccountInBucket(before, "spam", "me@x.com", () => ({
      doc_count: 0
    }));
    expect(next.spam.map((a) => a.doc_count)).toEqual([5]);
  });
});

describe("updateAccountInBuckets", () => {
  it("applies the update in every named bucket", () => {
    const next = updateAccountInBuckets(
      data(),
      ["received", "sent"],
      "me@x.com",
      ({ saved_doc_count }) => ({ saved_doc_count: saved_doc_count - 1 })
    );
    expect(next.received.map((a) => a.saved_doc_count)).toEqual([0, 1]);
    expect(next.sent.map((a) => a.saved_doc_count)).toEqual([0]);
    expect(next.spam.map((a) => a.saved_doc_count)).toEqual([1]);
  });

  it("hands the payload back untouched when no bucket is named", () => {
    const before = data();
    expect(updateAccountInBuckets(before, [], "me@x.com", () => ({}))).toBe(
      before
    );
  });
});

describe("removeAccountFromBucket", () => {
  it("drops the account from the named bucket only", () => {
    const before = data();
    const next = removeAccountFromBucket(before, "received", "me@x.com");
    expect(next.received.map((a) => a.key)).toEqual(["other@x.com"]);
    expect(next.sent.map((a) => a.key)).toEqual(["me@x.com"]);
    expect(next.received).not.toBe(before.received);
    expect(before.received).toHaveLength(2);
  });
});

describe("evictAccountFromCategory", () => {
  it("drops the account from the bucket a whole-bucket category lists", () => {
    expect(
      evictAccountFromCategory(
        data(),
        Category.AllMails,
        "me@x.com"
      ).received.map((a) => a.key)
    ).toEqual(["other@x.com"]);
    expect(
      evictAccountFromCategory(data(), Category.SentMails, "me@x.com").sent
    ).toEqual([]);
    expect(
      evictAccountFromCategory(data(), Category.SpamMails, "spammy@x.com").spam
    ).toEqual([]);
  });

  it("leaves the other buckets alone", () => {
    const next = evictAccountFromCategory(
      data(),
      Category.AllMails,
      "me@x.com"
    );
    expect(next.sent.map((a) => a.key)).toEqual(["me@x.com"]);
    expect(next.spam.map((a) => a.key)).toEqual(["spammy@x.com"]);
  });

  // Trashing the last unread mail empties the New Mails list without the
  // account leaving `received` — it still holds every read mail. Evicting on
  // that signal strands a real account out of every other view until a
  // refetch.
  it("keeps the account when the category only filters a bucket", () => {
    for (const category of [Category.NewMails, Category.SavedMails]) {
      expect(
        evictAccountFromCategory(data(), category, "me@x.com").received.map(
          (a) => a.key
        )
      ).toEqual(["me@x.com", "other@x.com"]);
    }
  });

  it("hands back the same payload for a category that lists no bucket", () => {
    const before = data();
    expect(
      evictAccountFromCategory(before, Category.NewMails, "me@x.com")
    ).toBe(before);
    expect(evictAccountFromCategory(before, Category.Search, "me@x.com")).toBe(
      before
    );
  });
});

// The helpers are pinned above, but nothing renders `Mails`, so a call site
// that hand-rolls the mapping is invisible to every other assertion here — and
// the counter it writes stays plausible until the next payload lands.
// `getAccountStats` builds `received` under `AND is_spam = FALSE`, so a
// Spam-view star credited to `received` goes to the one bucket the server will
// never count it in. Read via `Bun.file` rather than `fs`: sibling suites
// `mock.module("fs", ...)`, which is process-global in Bun. The whole source is
// stripped of whitespace before matching, so reflow and indentation are not
// failures; what it pins is the argument each existing call passes, not the
// absence of an edit written without the helper at all.
describe("the optimistic account edits in Mails", () => {
  it("names its buckets through bucketsForMail at every call site", async () => {
    const source = await Bun.file(
      new URL("./index.tsx", import.meta.url)
    ).text();
    const stripped = source.replace(/\s+/g, "");

    const call = "updateAccountInBuckets(";
    const expected =
      "updateAccountInBuckets(oldData,bucketsForMail(selectedCategory,mail," +
      "selectedAccount),selectedAccount,";

    const sites: string[] = [];
    for (
      let at = stripped.indexOf(call);
      at !== -1;
      at = stripped.indexOf(call, at + 1)
    ) {
      sites.push(stripped.slice(at, at + expected.length));
    }

    expect(sites).toEqual([expected, expected, expected, expected]);
  });
});
