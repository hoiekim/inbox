/**
 * Tests for case-insensitive INBOX matching (#600).
 *
 * RFC 3501 §5.1 mandates that the special name INBOX is matched in a
 * case-insensitive fashion. Pre-fix, every `=== "INBOX"` site in the layer
 * treated the comparison as case-sensitive, so a client sending `inbox`,
 * `Inbox`, etc. fell through to the per-account-mailbox path (treating
 * `inbox@<domain>` as a real account name — almost never existing). After
 * the layer added a mailbox-existence gate (#595), this surfaced as
 * `NO Mailbox does not exist` on a perfectly valid `SELECT inbox`.
 *
 * Coverage:
 *   - `isInbox()` util — every casing variant.
 *   - `Store.mailboxExists` — accepts every casing.
 *   - `selectMailbox` / `statusMailbox` — case-insensitive resolution AND
 *     canonical-name echoing in untagged responses (per the issue's fix
 *     sketch: "canonicalize the selected-mailbox string to INBOX so
 *     downstream responses echo the canonical name").
 */

import { describe, it, expect } from "bun:test";
import { isInbox } from "./util";
import { selectMailbox, statusMailbox } from "./mailbox-ops";
import { Store } from "./store";
import type { SignedUser } from "common";
import type { SequenceState } from "./sequence-resolver";

describe("isInbox util (#600)", () => {
  it("matches the canonical INBOX", () => {
    expect(isInbox("INBOX")).toBe(true);
  });

  it("matches lowercase", () => {
    expect(isInbox("inbox")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(isInbox("Inbox")).toBe(true);
    expect(isInbox("iNbOx")).toBe(true);
  });

  it("rejects non-INBOX names regardless of case", () => {
    expect(isInbox("Archive")).toBe(false);
    expect(isInbox("Sent Messages")).toBe(false);
    expect(isInbox("INBOX/accounts/foo")).toBe(false);
    expect(isInbox("INBOXX")).toBe(false);
    expect(isInbox("")).toBe(false);
  });
});

describe("Store.mailboxExists is case-insensitive for INBOX (#600)", () => {
  const makeStore = (): Store => {
    const store = new Store({ id: "u1", username: "admin" } as SignedUser);
    // Throw on listMailboxes so the test confirms the INBOX path skips it.
    // Non-INBOX names would call listMailboxes — we don't exercise those here.
    store.listMailboxes = async () => {
      throw new Error("listMailboxes should not be called for INBOX");
    };
    return store;
  };

  it("accepts the canonical INBOX", async () => {
    expect(await makeStore().mailboxExists("INBOX")).toBe(true);
  });

  it("accepts lowercase inbox", async () => {
    expect(await makeStore().mailboxExists("inbox")).toBe(true);
  });

  it("accepts mixed-case Inbox", async () => {
    expect(await makeStore().mailboxExists("Inbox")).toBe(true);
  });
});

const fakeStore = (): Store =>
  ({
    listMailboxes: async () => ["INBOX", "Archive"],
    mailboxExists: async (box: string) => isInbox(box) || box === "Archive",
    countMessages: async () => ({ total: 0, unread: 0, maxUid: 0 }),
    getAllUids: async () => [],
    getFirstUnseenUid: async () => null,
    getUser: () => ({ id: "u1", username: "admin" } as SignedUser),
  }) as unknown as Store;

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

const runSelect = async (name: string) => {
  const lines: string[] = [];
  let selectedMailbox: string | null = null;
  await selectMailbox(
    "A1",
    name,
    false,
    fakeStore(),
    (data: string) => {
      lines.push(data);
      return true;
    },
    emptySeqState(),
    (mailbox) => {
      selectedMailbox = mailbox;
    },
    () => {}
  );
  return { lines, selectedMailbox };
};

const runStatus = async (mailbox: string) => {
  const lines: string[] = [];
  await statusMailbox(
    "A1",
    mailbox,
    ["MESSAGES"],
    fakeStore(),
    (data: string) => {
      lines.push(data);
      return true;
    }
  );
  return lines;
};

describe("SELECT canonicalizes INBOX casing (#600)", () => {
  // The fake Store can't satisfy the full SELECT happy-path flow
  // (`getImapUidValidity` calls into postgres directly, not via the store),
  // so the OK-response tail never lands here. What matters for this fix is
  // the `setSelected(canonicalName, …)` call on line 388 of mailbox-ops.ts:
  // that runs immediately after the existence gate and BEFORE any downstream
  // DB hit, capturing whatever the canonicalization produced. So the
  // `selectedMailbox` value the callback sees IS the canonicalized name the
  // session will store — exactly what every downstream consumer (FETCH UID,
  // APPEND, IDLE, _processFetchMessages) reads. The "NO does not exist"
  // assertion confirms the existence gate passed, i.e. case-insensitive
  // resolution worked end-to-end.

  it("SELECT inbox resolves to INBOX and the session stores INBOX", async () => {
    const { lines, selectedMailbox } = await runSelect("inbox");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
    expect(selectedMailbox).toBe("INBOX");
  });

  it("SELECT Inbox (mixed case) also resolves to INBOX", async () => {
    const { lines, selectedMailbox } = await runSelect("Inbox");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
    expect(selectedMailbox).toBe("INBOX");
  });

  it("SELECT INBOX (canonical) still resolves to INBOX (regression)", async () => {
    const { lines, selectedMailbox } = await runSelect("INBOX");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
    expect(selectedMailbox).toBe("INBOX");
  });

  it("SELECT Archive (non-INBOX) is unaffected — still case-sensitive", async () => {
    const { selectedMailbox } = await runSelect("Archive");
    // Non-INBOX names pass through unchanged; only INBOX is canonicalized.
    expect(selectedMailbox).toBe("Archive");

    const lower = await runSelect("archive");
    // "archive" ≠ "Archive" — not a special name, stays case-sensitive,
    // mailboxExists fakeStore returns false for it, setSelected never runs.
    expect(
      lower.lines.some((l) => l.includes("NO Mailbox does not exist"))
    ).toBe(true);
    expect(lower.selectedMailbox).toBeNull();
  });
});

describe("STATUS canonicalizes INBOX casing in response echo (#600)", () => {
  it("STATUS inbox echoes the response as INBOX, not inbox", async () => {
    const lines = await runStatus("inbox");
    expect(lines).toContain(
      '* STATUS "INBOX" (MESSAGES 0)\r\n'
    );
    expect(lines.some((l) => l.startsWith('* STATUS "inbox"'))).toBe(false);
    expect(lines).toContain("A1 OK STATUS completed\r\n");
  });

  it("STATUS Inbox (mixed) echoes the response as INBOX", async () => {
    const lines = await runStatus("Inbox");
    expect(lines).toContain(
      '* STATUS "INBOX" (MESSAGES 0)\r\n'
    );
  });

  it("STATUS INBOX (canonical) is unchanged (regression)", async () => {
    const lines = await runStatus("INBOX");
    expect(lines).toContain(
      '* STATUS "INBOX" (MESSAGES 0)\r\n'
    );
  });
});
