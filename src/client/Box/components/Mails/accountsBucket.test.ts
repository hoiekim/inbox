import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { Category } from "client";
import {
  bucketForCategory,
  evictAccountFromCategory,
  listsWholeBucket,
  removeAccountFromBucket,
  updateAccountInBucket
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

describe("bucketForCategory", () => {
  it("maps each category to the list carrying its counters", () => {
    expect(bucketForCategory(Category.SentMails)).toBe("sent");
    expect(bucketForCategory(Category.SpamMails)).toBe("spam");
    expect(bucketForCategory(Category.AllMails)).toBe("received");
    expect(bucketForCategory(Category.NewMails)).toBe("received");
    expect(bucketForCategory(Category.SavedMails)).toBe("received");
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

// The helper is pinned above, but nothing renders `Mails`, so a call site that
// hand-rolls the mapping is invisible to every other assertion here — and the
// counter it writes stays plausible until the next payload lands.
// `getAccountStats` builds `received` under `AND is_spam = FALSE`, so a
// Spam-view star credited to `received` goes to the one bucket the server will
// never count it in. Read via `Bun.file` rather than `fs`: sibling suites
// `mock.module("fs", ...)`, which is process-global in Bun. Whitespace is
// stripped, not collapsed, so a rewrap is not a failure.
describe("the optimistic account edits in Mails", () => {
  it("names its bucket through bucketForCategory at every call site", async () => {
    const source = await Bun.file(
      new URL("./index.tsx", import.meta.url)
    ).text();

    const call = "updateAccountInBucket(";
    const expected =
      "updateAccountInBucket(oldData,bucketForCategory(selectedCategory)," +
      "selectedAccount,";

    const sites: string[] = [];
    for (let at = source.indexOf(call); at !== -1; at = source.indexOf(call, at + 1)) {
      const stripped = source.slice(at, at + 200).replace(/\s+/g, "");
      sites.push(stripped.slice(0, expected.length));
    }

    expect(sites).toEqual([expected, expected, expected, expected]);
  });
});
