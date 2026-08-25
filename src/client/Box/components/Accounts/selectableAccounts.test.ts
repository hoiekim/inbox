import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { Category } from "client";
import {
  accountsForCategory,
  resolveSelectedAccount
} from "./selectableAccounts";

const makeAccount = (key: string, unread = 0, saved = 0) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: 1,
    unread_doc_count: unread,
    saved_doc_count: saved
  });

const received = [
  makeAccount("read@x.com"),
  makeAccount("unread@x.com", 3),
  makeAccount("starred@x.com", 0, 2)
];
const sent = [makeAccount("sender@x.com")];
const spam = [makeAccount("spammy@x.com")];
const lists = { received, sent, spam };

const keys = (category: Category) =>
  accountsForCategory(category, lists).map((a) => a.key);

describe("accountsForCategory", () => {
  it("lists received accounts for All Mails", () => {
    expect(keys(Category.AllMails)).toEqual([
      "read@x.com",
      "unread@x.com",
      "starred@x.com"
    ]);
  });

  it("lists only accounts with unread mail for New Mails", () => {
    expect(keys(Category.NewMails)).toEqual(["unread@x.com"]);
  });

  it("lists only accounts with starred mail for Saved Mails", () => {
    expect(keys(Category.SavedMails)).toEqual(["starred@x.com"]);
  });

  it("lists sent accounts for Sent Mails", () => {
    expect(keys(Category.SentMails)).toEqual(["sender@x.com"]);
  });

  it("lists spam accounts for Spam Mails", () => {
    expect(keys(Category.SpamMails)).toEqual(["spammy@x.com"]);
  });

  it("does not list a sent-only account under All Mails", () => {
    expect(keys(Category.AllMails)).not.toContain("sender@x.com");
  });

  it("does not list a spam-only account under All Mails", () => {
    expect(keys(Category.AllMails)).not.toContain("spammy@x.com");
  });

  it("does not list a received account under Sent Mails", () => {
    expect(keys(Category.SentMails)).not.toContain("read@x.com");
  });

  it("returns an empty list when the server returned no accounts", () => {
    expect(accountsForCategory(Category.AllMails, {})).toEqual([]);
    expect(accountsForCategory(Category.SentMails, {})).toEqual([]);
    expect(accountsForCategory(Category.SpamMails, {})).toEqual([]);
  });

  it("lists nothing for Search, where the value is a search term", () => {
    expect(accountsForCategory(Category.Search, lists)).toEqual([]);
  });
});

describe("resolveSelectedAccount", () => {
  it("leaves a selection the category lists alone", () => {
    expect(
      resolveSelectedAccount("unread@x.com", Category.NewMails, lists)
    ).toBe(null);
    expect(resolveSelectedAccount("sender@x.com", Category.SentMails, lists))
      .toBe(null);
  });

  it("re-anchors to the category's first account when the selection is not in it", () => {
    expect(resolveSelectedAccount("sender@x.com", Category.AllMails, lists))
      .toBe("read@x.com");
    expect(resolveSelectedAccount("read@x.com", Category.NewMails, lists))
      .toBe("unread@x.com");
  });

  it("picks the category's first account when nothing is selected", () => {
    expect(resolveSelectedAccount("", Category.SentMails, lists)).toBe(
      "sender@x.com"
    );
    expect(resolveSelectedAccount("", Category.SpamMails, lists)).toBe(
      "spammy@x.com"
    );
  });

  it("clears a selection the category cannot host", () => {
    expect(
      resolveSelectedAccount("read@x.com", Category.SentMails, {
        received,
        sent: []
      })
    ).toBe("");
  });

  // The infinite-loop guard: with the category list empty and nothing
  // selected there is no next value, so the effect must not write. Returning
  // "" here instead of null makes <Accounts> set state on every render.
  it("returns null rather than re-clearing an already-empty selection", () => {
    expect(
      resolveSelectedAccount("", Category.SentMails, { received, sent: [] })
    ).toBe(null);
    expect(
      resolveSelectedAccount("", Category.SpamMails, { received, spam: [] })
    ).toBe(null);
    expect(
      resolveSelectedAccount("", Category.NewMails, {
        received: [makeAccount("read@x.com")]
      })
    ).toBe(null);
  });

  // Loop-freedom as a property: feeding the resolver its own output back has
  // to settle, for every category and every payload shape. The two-effect
  // shape this replaced never settled when the current category listed
  // nothing — it alternated between "" and received[0] forever.
  it("settles in at most one step from any selection, category and payload", () => {
    const payloads: [string, Parameters<typeof resolveSelectedAccount>[2]][] = [
      ["all populated", lists],
      ["no sent", { received, sent: [], spam }],
      ["no spam", { received, sent, spam: [] }],
      ["no received", { received: [], sent, spam }],
      ["nothing unread or starred", { received: [makeAccount("read@x.com")] }],
      ["empty payload", {}]
    ];
    const starts = [
      "",
      "phantom@x.com",
      "read@x.com",
      "unread@x.com",
      "sender@x.com",
      "spammy@x.com"
    ];

    const diverged: string[] = [];
    for (const [label, payload] of payloads) {
      for (const category of Object.values(Category)) {
        for (const start of starts) {
          let current = start;
          let steps = 0;
          while (steps < 10) {
            const next = resolveSelectedAccount(current, category, payload);
            if (next === null) break;
            current = next;
            steps += 1;
          }
          if (steps > 1) diverged.push(`${category} | ${label} | "${start}"`);
        }
      }
    }

    expect(diverged).toEqual([]);
  });

  it("never resolves in Search, where the value is the live search term", () => {
    expect(resolveSelectedAccount("keyword", Category.Search, lists)).toBe(
      null
    );
    expect(resolveSelectedAccount("", Category.Search, lists)).toBe(null);
  });

  // The accounts route answers `success` with three empty lists when its stats
  // query fails, so an empty payload is not evidence the selection is stale.
  it("keeps the selection when the payload holds no accounts at all", () => {
    expect(resolveSelectedAccount("read@x.com", Category.AllMails, {})).toBe(
      null
    );
    expect(
      resolveSelectedAccount("read@x.com", Category.AllMails, {
        received: [],
        sent: [],
        spam: []
      })
    ).toBe(null);
  });
});
