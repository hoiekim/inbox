
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { SignedUser } from "common";

const mockGetAccountStats = mock(() => Promise.resolve([]));
const mockCountMessages = mock(() => Promise.resolve({ total: 0, unread: 0 }));
const mockGetMailsByRange = mock(() => Promise.resolve(new Map()));
const mockSetMailFlags = mock(() => Promise.resolve());
const mockSearchMailsByUid = mock(() => Promise.resolve([]));
const mockSaveMail = mock(() => Promise.resolve({ _id: "x" }));
const mockExpunge = mock(() => Promise.resolve(0));
const mockGetAllUids = mock(() => Promise.resolve([]));
const mockGetFirstUnseenUid = mock<(...args: unknown[]) => Promise<number | null>>(() =>
  Promise.resolve(null)
);
const mockGetUidNext = mock<(...args: unknown[]) => Promise<number>>(() => Promise.resolve(1));

mock.module("../postgres/repositories/mails", () => ({
  getAccountStats: mockGetAccountStats,
  countMessages: mockCountMessages,
  getMailsByRange: mockGetMailsByRange,
  setMailFlags: mockSetMailFlags,
  searchMailsByUid: mockSearchMailsByUid,
  saveMail: mockSaveMail,
  expungeDeletedMails: mockExpunge,
  getAllUids: mockGetAllUids,
  getFirstUnseenUid: mockGetFirstUnseenUid,
  getUidNext: mockGetUidNext,
}));

const mockGetMailboxesByUser = mock(() => Promise.resolve([]));
mock.module("../postgres/repositories/mailboxes", () => ({
  getMailboxesByUser: mockGetMailboxesByUser,
}));

mock.module("server", () => ({
  logger: { warn: mock(() => {}), error: mock(() => {}), info: mock(() => {}), debug: mock(() => {}) },
  getUserDomain: (username: string) =>
    username === "admin" ? "example.com" : `${username}.example.com`,
}));

import { Store, simplifyCriterion } from "./store";
import { UTILITY_FOLDERS } from "./util";

const makeUser = (overrides: Partial<{ id: string; username: string; email: string }> = {}) =>
  new SignedUser({
    id: "user-123",
    username: "alice",
    email: "alice@alice.example.com",
    ...overrides,
  });

describe("Store.listMailboxes", () => {
  beforeEach(() => {
    mockGetAccountStats.mockClear();
    mockGetMailboxesByUser.mockClear();
    mockGetAccountStats.mockResolvedValue([]);
    mockGetMailboxesByUser.mockResolvedValue([]);
  });

  it("passes the user's domain as the third arg to both getAccountStats calls (regression PR #310 / #196)", async () => {
    const store = new Store(makeUser());
    await store.listMailboxes();

    expect(mockGetAccountStats).toHaveBeenCalledTimes(2);
    expect(mockGetAccountStats).toHaveBeenCalledWith("user-123", false, "alice.example.com");
    expect(mockGetAccountStats).toHaveBeenCalledWith("user-123", true, "alice.example.com");
  });

  it("uses the bare EMAIL_DOMAIN for the admin user, not 'admin.<domain>'", async () => {
    const store = new Store(
      makeUser({ id: "admin-1", username: "admin", email: "admin@example.com" })
    );
    await store.listMailboxes();

    expect(mockGetAccountStats).toHaveBeenCalledWith("admin-1", false, "example.com");
    expect(mockGetAccountStats).toHaveBeenCalledWith("admin-1", true, "example.com");
  });

  it("returns only the server-defined boxes when no accounts and no user mailboxes exist", async () => {
    const store = new Store(makeUser());
    const result = await store.listMailboxes();
    expect(result).toEqual(["INBOX", "Drafts", "Junk", "Starred", "Trash"]);
  });
});

describe("Store.storeMail — what the destination box decides (#725)", () => {
  const makeMail = () =>
    ({
      messageId: "m-1",
      subject: "s",
      draft: false,
      uid: { domain: 7, account: 3 },
    }) as never;

  const savedInput = () =>
    mockSaveMail.mock.calls[0][0] as unknown as Record<string, unknown>;

  beforeEach(() => {
    mockSaveMail.mockClear();
    mockSaveMail.mockResolvedValue({ _id: "x" } as never);
  });

  it("sets the membership flag for a utility destination", async () => {
    // A client that APPENDs to `Drafts` without sending `\Draft` still means
    // "this is a draft". Without the flag the row is written and shows up in no
    // mailbox the client asked for.
    await new Store(makeUser()).storeMail(makeMail(), "Drafts");
    expect(savedInput().placement).toEqual({ draft: true });
  });

  it("records no mapping row for a utility destination", async () => {
    // Utility views enumerate uid_domain; a mapping row would give the mail a
    // per-box UID nothing reads and burn a counter value.
    await new Store(makeUser()).storeMail(makeMail(), "Junk");
    expect(savedInput().mailbox).toBeUndefined();
    expect(savedInput().placement).toEqual({ is_spam: true });
  });

  it("records the mapping row for a mapped destination and touches no flag", async () => {
    await new Store(makeUser()).storeMail(makeMail(), "INBOX/accounts/alice");
    expect(savedInput().mailbox).toBe("INBOX/accounts/alice");
    expect(savedInput().placement).toBeUndefined();
  });

  it("records no mapping row for INBOX or the unified Sent view", async () => {
    await new Store(makeUser()).storeMail(makeMail(), "INBOX");
    expect(savedInput().mailbox).toBeUndefined();
    mockSaveMail.mockClear();
    await new Store(makeUser()).storeMail(makeMail(), "Sent Messages");
    expect(savedInput().mailbox).toBeUndefined();
  });

  it("lists an unsubscribed user mailbox — LIST is not subscription-filtered", async () => {
    mockGetMailboxesByUser.mockResolvedValue([
      { name: "Archive", special_use: null, address: null, subscribed: false },
    ] as never);
    const store = new Store(makeUser());
    expect(await store.listMailboxes()).toEqual([
      "INBOX",
      "Drafts",
      "Junk",
      "Starred",
      "Trash",
      "Archive",
    ]);
  });
});

describe("Store.listMailboxEntries — subscription state for LSUB (#688)", () => {
  beforeEach(() => {
    mockGetAccountStats.mockClear();
    mockGetMailboxesByUser.mockClear();
    mockGetAccountStats.mockResolvedValue([]);
    mockGetMailboxesByUser.mockResolvedValue([]);
  });

  it("carries each user mailbox's subscribed column through", async () => {
    mockGetMailboxesByUser.mockResolvedValue([
      { name: "ZzSubYes", special_use: null, address: null, subscribed: true },
      { name: "ZzSubNo", special_use: null, address: null, subscribed: false },
    ] as never);

    const store = new Store(makeUser());
    const entries = await store.listMailboxEntries();

    expect(entries).toContainEqual({ name: "ZzSubYes", subscribed: true });
    expect(entries).toContainEqual({ name: "ZzSubNo", subscribed: false });
  });

  it("marks the derived mailboxes subscribed — they have no row to unsubscribe from", async () => {
    mockGetAccountStats.mockResolvedValue([{ address: "work@alice.example.com" }] as never);

    const store = new Store(makeUser());
    const entries = await store.listMailboxEntries();

    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every((entry) => entry.subscribed)).toBe(true);
    expect(entries.map((entry) => entry.name)).toContain("INBOX");
  });

  it("falls back to a subscribed INBOX when the backend throws", async () => {
    mockGetMailboxesByUser.mockRejectedValue(new Error("db down"));
    const store = new Store(makeUser());
    expect(await store.listMailboxEntries()).toEqual([{ name: "INBOX", subscribed: true }]);
  });
});

describe("simplifyCriterion — NOT/OR operand normalisation (regression for #551)", () => {
  // The parser emits NOT/OR with RAW inner criteria (.criterion / .left / .right),
  // and raw text/date/header criteria use heterogeneous field names (.value/.date/.field).
  // simplifyCriterion must recurse so the SQL builder always sees the flat
  // { type, value } shape — otherwise nested NOT/OR criteria were mis-read or dropped.

  it("normalises NOT's inner criterion (flag)", () => {
    expect(
      simplifyCriterion({ type: "NOT", criterion: { type: "SEEN" } } as never)
    ).toEqual({ type: "NOT", value: { type: "SEEN" } });
  });

  it("normalises NOT's inner text criterion onto .value", () => {
    expect(
      simplifyCriterion({
        type: "NOT",
        criterion: { type: "FROM", value: "spam@x" },
      } as never)
    ).toEqual({ type: "NOT", value: { type: "FROM", value: "spam@x" } });
  });

  it("normalises a NOT BEFORE date from .date to .value", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    expect(
      simplifyCriterion({
        type: "NOT",
        criterion: { type: "BEFORE", date: when },
      } as never)
    ).toEqual({ type: "NOT", value: { type: "BEFORE", value: when } });
  });

  it("normalises both OR operands recursively", () => {
    expect(
      simplifyCriterion({
        type: "OR",
        left: { type: "FROM", value: "alice" },
        right: { type: "TO", value: "bob" },
      } as never)
    ).toEqual({
      type: "OR",
      value: {
        left: { type: "FROM", value: "alice" },
        right: { type: "TO", value: "bob" },
      },
    });
  });

  it("normalises a multi-element UID set into one UID_SET carrying every range (#659)", () => {
    expect(
      simplifyCriterion({
        type: "UID",
        sequenceSet: { ranges: [{ start: 1 }, { start: 3, end: 5 }] },
      } as never)
    ).toEqual({ type: "UID_SET", value: [{ start: 1 }, { start: 3, end: 5 }] });
  });

  it("normalises a nested UID operand of an OR into a UID_SET (#659)", () => {
    expect(
      simplifyCriterion({
        type: "OR",
        left: { type: "FROM", value: "alice" },
        right: { type: "UID", sequenceSet: { ranges: [{ start: 1 }, { start: 3 }] } },
      } as never)
    ).toEqual({
      type: "OR",
      value: {
        left: { type: "FROM", value: "alice" },
        right: { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      },
    });
  });

  it("normalises HEADER's field/value into { field, text }", () => {
    expect(
      simplifyCriterion({ type: "HEADER", field: "Subject", value: "hi" } as never)
    ).toEqual({ type: "HEADER", value: { field: "Subject", text: "hi" } });
  });
});

describe("simplifyCriterion — unexpressible criteria are preserved, not dropped (#672)", () => {
  // Dropping a criterion here (returning null) removes it from the WHERE clause,
  // which matches every message (fail-open). Instead these are preserved so
  // buildCriterionClause can fail them CLOSED. KEYWORD/UNKEYWORD normalise to a
  // bare { type } (the flag value is irrelevant — no custom keywords are stored).

  it("preserves KEYWORD as a bare { type }", () => {
    expect(simplifyCriterion({ type: "KEYWORD", flag: "Foo" } as never)).toEqual({
      type: "KEYWORD",
    });
  });

  it("preserves UNKEYWORD as a bare { type }", () => {
    expect(simplifyCriterion({ type: "UNKEYWORD", flag: "Foo" } as never)).toEqual({
      type: "UNKEYWORD",
    });
  });

  it("preserves an unknown criterion type instead of dropping it to null", () => {
    expect(simplifyCriterion({ type: "SOMETHING-UNSUPPORTED" } as never)).toEqual({
      type: "SOMETHING-UNSUPPORTED",
    });
  });
});

describe("Store.getFirstUnseenUid", () => {
  beforeEach(() => {
    mockGetFirstUnseenUid.mockClear();
    mockGetFirstUnseenUid.mockResolvedValue(null);
  });

  it("forwards the resolved account/sent for INBOX and returns the unseen UID", async () => {
    mockGetFirstUnseenUid.mockResolvedValue(42);
    const store = new Store(makeUser());
    const result = await store.getFirstUnseenUid("INBOX");

    expect(result).toBe(42);
    expect(mockGetFirstUnseenUid).toHaveBeenCalledWith("user-123", null, false);
  });

  it("returns null when every message is read", async () => {
    mockGetFirstUnseenUid.mockResolvedValue(null);
    const store = new Store(makeUser());
    expect(await store.getFirstUnseenUid("INBOX")).toBeNull();
  });

  it("returns null instead of throwing when the repository query fails", async () => {
    mockGetFirstUnseenUid.mockRejectedValue(new Error("db down"));
    const store = new Store(makeUser());
    expect(await store.getFirstUnseenUid("INBOX")).toBeNull();
  });
});

describe("Store.getMessages — replyTo mapping (#667)", () => {
  beforeEach(() => {
    mockGetMailsByRange.mockClear();
    mockGetMailsByRange.mockResolvedValue(new Map());
  });

  it("maps reply_to_address/reply_to_text onto mail.replyTo", async () => {
    const replyToValue = [{ address: "noreply@vendor.example", name: "Vendor" }];
    mockGetMailsByRange.mockResolvedValue(
      new Map([
        [
          "doc-1",
          {
            message_id: "<m1>",
            from_address: [{ address: "sender@vendor.example", name: "Vendor" }],
            from_text: "Vendor <sender@vendor.example>",
            reply_to_address: replyToValue,
            reply_to_text: "Vendor <noreply@vendor.example>",
          },
        ],
      ]) as never
    );

    const store = new Store(makeUser());
    const mails = await store.getMessages("INBOX", 1, 1, ["replyTo", "from"]);
    const mail = mails.get("doc-1");

    expect(mail?.replyTo).toEqual({
      value: replyToValue,
      text: "Vendor <noreply@vendor.example>",
    });
  });

  it("leaves replyTo undefined when the column is absent (no spurious NIL-vs-value flip)", async () => {
    mockGetMailsByRange.mockResolvedValue(
      new Map([["doc-2", { message_id: "<m2>", from_address: [] }]]) as never
    );

    const store = new Store(makeUser());
    const mails = await store.getMessages("INBOX", 1, 1, ["from"]);

    expect(mails.get("doc-2")?.replyTo).toBeUndefined();
  });
});

/**
 * `Store.getUidNext` must peek the counter row its box's WRITE path reserves
 * through, and there are three of them: the domain counter, the per-mailbox
 * counter, and the per-account counter. Reading any other row means COALESCE
 * falls through to a seed over rows the box does not own, and UIDNEXT comes
 * back at or below UIDs already handed out.
 *
 * Two edits would silently restore that, which is why the axis is asserted per
 * UID-space class rather than per path shape: harmonising this with its
 * `resolveMappedBox` siblings (giving the peek a raw-box-path scope nothing
 * writes), and collapsing the three branches back onto the address axis
 * (which puts `Drafts`/`Junk`/`Starred`/`Trash` on counters nothing writes).
 */
describe("Store.getUidNext — counter key axis", () => {
  beforeEach(() => {
    mockGetUidNext.mockClear();
    mockGetUidNext.mockResolvedValue(1);
  });

  const scopeFor = async (box: string) => {
    mockGetUidNext.mockClear();
    const store = new Store(makeUser());
    await store.getUidNext(box);
    return mockGetUidNext.mock.calls[0][1];
  };

  it("reads the domain counter for every box whose UIDs come from mails.uid_domain", async () => {
    // INBOX and unified Sent Messages hold no mapping rows; Drafts and Junk are
    // predicates over the same domain UID space. All four are written by
    // getDomainUidNext, so all four must peek the kind="domain" row.
    for (const [box, sent] of [
      ["INBOX", false],
      ["Sent Messages", true],
      ["Drafts", false],
      ["Junk", false],
    ] as const) {
      expect(await scopeFor(box)).toEqual({ kind: "domain", sent });
    }
  });

  it("reads the per-mailbox counter for a mapped-utility box, with no sent axis", async () => {
    // Starred/Trash are one mailbox each, reserved through getMailboxUidNext
    // under the literal box name — the same string mail_mailbox_uid.mailbox holds.
    expect(await scopeFor("Starred")).toEqual({ kind: "mailbox", mailbox: "Starred" });
    expect(await scopeFor("Trash")).toEqual({ kind: "mailbox", mailbox: "Trash" });
  });

  it("canonicalizes a mapped-utility box before using it as the counter scope", async () => {
    // utilityFolder matches case-insensitively but the pivot rows carry the
    // canonical spelling, so a lowercased SELECT must not open a second counter.
    expect(await scopeFor("starred")).toEqual({ kind: "mailbox", mailbox: "Starred" });
  });

  it("reads the per-account counter keyed by ADDRESS, not the box path", async () => {
    expect(await scopeFor("INBOX/accounts/bob")).toEqual({
      kind: "account",
      account: "bob@alice.example.com",
      sent: false,
    });
    expect(await scopeFor("Sent Messages/accounts/bob")).toEqual({
      kind: "account",
      account: "bob@alice.example.com",
      sent: true,
    });
    // `boxToAccount("Archive")` -> "Archive@<domain>", the same string the
    // COPY/MOVE write path reserves under.
    expect(await scopeFor("Archive")).toEqual({
      kind: "account",
      account: "Archive@alice.example.com",
      sent: false,
    });
  });

  it("never passes a raw box path as an account scope", async () => {
    for (const box of ["INBOX/accounts/bob", "Sent Messages/accounts/bob", "Archive"]) {
      const scope = await scopeFor(box);
      expect(scope.kind).toBe("account");
      expect(scope.account).not.toBe(box);
      expect(scope.account).toContain("@");
    }
  });

  it("gives every declared utility folder the UID space its declaration names", async () => {
    // Derived from UTILITY_FOLDERS rather than a hand-written list: a fifth
    // folder added with either uidSpace is covered the moment it is declared,
    // which is how Drafts/Junk slipped onto the account counter unnoticed.
    for (const folder of UTILITY_FOLDERS) {
      const scope = await scopeFor(folder.name);
      expect(scope.kind).toBe(folder.uidSpace === "domain" ? "domain" : "mailbox");
      expect(scope.kind).not.toBe("account");
    }
  });

  it("propagates a repository failure instead of substituting a floor", async () => {
    // A swallowed fault would surface as a too-low UIDNEXT — the bug itself.
    mockGetUidNext.mockImplementation(() => Promise.reject(new Error("DB down")));
    const store = new Store(makeUser());
    await expect(store.getUidNext("INBOX")).rejects.toThrow("DB down");
  });
});
