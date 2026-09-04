import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { Category } from "client";
import {
  accountsForCategory,
  categoryForAccount,
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

  // A category with nothing to offer must not spend a selection that some
  // other list still holds: the sidebar says the category is empty either way,
  // and the trip back to a populated category would then re-anchor to its
  // first account rather than this one.
  it("keeps a real selection when the category lists nothing", () => {
    expect(
      resolveSelectedAccount("starred@x.com", Category.SentMails, {
        received,
        sent: []
      })
    ).toBe(null);
    expect(
      resolveSelectedAccount("starred@x.com", Category.SpamMails, {
        received,
        spam: []
      })
    ).toBe(null);
  });

  // Realness spans every list, not just `received`: an address can hold sent or
  // spam mail and no received mail at all, and judging it against `received`
  // alone would clear a selection the Sent or Spam view still lists.
  it("keeps a sent-only or spam-only selection when the category lists nothing", () => {
    expect(
      resolveSelectedAccount("sender@x.com", Category.SpamMails, {
        received: [],
        sent,
        spam: []
      })
    ).toBe(null);
    expect(
      resolveSelectedAccount("spammy@x.com", Category.SentMails, {
        received: [],
        sent: [],
        spam
      })
    ).toBe(null);
  });

  it("never resolves to an account the category does not list", () => {
    const payloads: Parameters<typeof resolveSelectedAccount>[2][] = [
      lists,
      { received, sent: [], spam: [] },
      { received: [], sent, spam },
      {}
    ];
    const offered: string[] = [];
    for (const payload of payloads) {
      for (const category of Object.values(Category)) {
        for (const start of ["", "phantom@x.com", "read@x.com", "sender@x.com"]) {
          const next = resolveSelectedAccount(start, category, payload);
          if (next === null) continue;
          const listed = accountsForCategory(category, payload).map((a) => a.key);
          // "" is a clear, not an account, and is only ever right where the
          // category has no row to anchor to.
          const ok = next === "" ? !listed.length : listed.includes(next);
          if (!ok) offered.push(`${category} | "${start}" -> "${next}"`);
        }
      }
    }
    expect(offered).toEqual([]);
  });

  // With the category list empty there is no next value, so the caller must
  // not write. Returning "" here instead of null makes <Accounts> set state on
  // every render.
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
  // to settle, for every category and every payload shape.
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

  // Realness is judged against every list, listing against the current
  // category's own. A name no list holds is unreachable state wherever it came
  // from, and an empty category is not a reason to keep it: deleting the last
  // mail of the only account leaves exactly this payload, and staying put is
  // the stranding the whole hook exists to end.
  it("clears a name no list holds when the category lists nothing", () => {
    expect(
      resolveSelectedAccount("search term", Category.SentMails, {
        received,
        sent: []
      })
    ).toBe("");
    expect(resolveSelectedAccount("gone@x.com", Category.AllMails, {})).toBe("");
    expect(
      resolveSelectedAccount("gone@x.com", Category.AllMails, {
        received: [],
        sent: [],
        spam: []
      })
    ).toBe("");
  });

  // Clearing hands the pane back to <GettingStarted>, which is gated on an
  // empty selection — the affordance the phantom state has none of.
  it("clears rather than re-anchors when no category can host the name", () => {
    const afterLastMailDeleted = { received: [], sent: [], spam: [] };
    let selected = "gone@x.com";
    const resolved = resolveSelectedAccount(
      selected,
      Category.AllMails,
      afterLastMailDeleted
    );
    expect(resolved).toBe("");
    selected = resolved as string;
    expect(
      resolveSelectedAccount(selected, Category.AllMails, afterLastMailDeleted)
    ).toBe(null);
  });
});

describe("categoryForAccount", () => {
  it("sends a received account to All Mails", () => {
    expect(categoryForAccount("read@x.com", lists)).toBe(Category.AllMails);
  });

  // The search side-tab spans spam, which the received list excludes, so a
  // spam-only match has to land on the spam view or the anchor moves it off
  // the account the user clicked.
  it("sends a spam-only account to Spam Mails", () => {
    expect(categoryForAccount("spammy@x.com", lists)).toBe(Category.SpamMails);
  });

  it("sends a sent-only account to Sent Mails", () => {
    expect(categoryForAccount("sender@x.com", lists)).toBe(Category.SentMails);
  });

  // An address that also holds ordinary received mail belongs on its primary
  // view, not on whichever list the matching mail happened to sit in.
  it("prefers All Mails when more than one list holds the account", () => {
    const alsoSent = {
      received: [makeAccount("me@x.com")],
      sent: [makeAccount("me@x.com")]
    };
    expect(categoryForAccount("me@x.com", alsoSent)).toBe(Category.AllMails);

    const alsoSpam = {
      received: [makeAccount("me@x.com")],
      spam: [makeAccount("me@x.com")]
    };
    expect(categoryForAccount("me@x.com", alsoSpam)).toBe(Category.AllMails);
  });

  it("falls back to All Mails for an account no list holds", () => {
    expect(categoryForAccount("phantom@x.com", lists)).toBe(Category.AllMails);
  });

  // Every category it can answer with must actually host the account, or the
  // click lands on a list the selection is not in.
  it("only answers with a category that lists the account", () => {
    for (const key of ["read@x.com", "sender@x.com", "spammy@x.com"]) {
      const category = categoryForAccount(key, lists);
      expect(accountsForCategory(category, lists).map((a) => a.key)).toContain(
        key
      );
    }
  });
});
