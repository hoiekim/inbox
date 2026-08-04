/**
 * Tests for LSUB's subscription filter (RFC 3501 §6.3.9, #688).
 *
 * Before the fix, listSubscribedMailboxes read the same `store.listMailboxes()`
 * set LIST reads and filtered only by the pattern, so LSUB output was
 * byte-identical to LIST and UNSUBSCRIBE was a persistent no-op. These cases
 * pin that an unsubscribed user-created mailbox drops out of LSUB, that the
 * derived system mailboxes stay in regardless, and that hierarchy attributes
 * are still computed against the full listable set.
 */

import { describe, it, expect } from "bun:test";
import { listSubscribedMailboxes, listMailboxes } from "./mailbox-ops";
import type { MailboxEntry, Store } from "./store";

const TREE: MailboxEntry[] = [
  { name: "INBOX", subscribed: true },
  { name: "Sent Messages", subscribed: true },
  { name: "Sent Messages/accounts", subscribed: true },
  { name: "Sent Messages/accounts/work", subscribed: true },
  { name: "INBOX/accounts", subscribed: true },
  { name: "INBOX/accounts/work", subscribed: true },
  { name: "ZzSubYes", subscribed: true },
  { name: "ZzSubNo", subscribed: false },
];

const fakeStore = (entries: MailboxEntry[]): Store =>
  ({
    listMailboxEntries: async () => entries,
    listMailboxes: async () => entries.map((entry) => entry.name),
  }) as unknown as Store;

const emit = async (
  command: typeof listSubscribedMailboxes,
  reference: string,
  pattern: string,
  entries: MailboxEntry[] = TREE
): Promise<string[]> => {
  const lines: string[] = [];
  await command("A1", reference, pattern, fakeStore(entries), (data: string) => {
    lines.push(data);
    return true;
  });
  return lines;
};

const namesOf = (lines: string[]): string[] =>
  lines
    .filter((line) => line.startsWith("* LSUB"))
    .map((line) => line.replace(/.*"\/" "(.*)"\r\n$/, "$1"));

describe("LSUB honours the subscribed flag (#688)", () => {
  it("omits an unsubscribed user-created mailbox", async () => {
    const names = namesOf(await emit(listSubscribedMailboxes, "", "ZzSub*"));
    expect(names).toEqual(["ZzSubYes"]);
    expect(names).not.toContain("ZzSubNo");
  });

  it("still returns the subscribed sibling that LIST returns", async () => {
    const lines: string[] = [];
    await listMailboxes("A1", "", "ZzSub*", fakeStore(TREE), (data: string) => {
      lines.push(data);
      return true;
    });
    const listNames = lines
      .filter((line) => line.startsWith("* LIST"))
      .map((line) => line.replace(/.*"\/" "(.*)"\r\n$/, "$1"));

    // LIST is unchanged — it reports both. The two commands must now differ.
    expect(listNames.sort()).toEqual(["ZzSubNo", "ZzSubYes"]);
  });

  it("keeps INBOX in LSUB — it has no mailboxes row to unsubscribe from", async () => {
    const names = namesOf(await emit(listSubscribedMailboxes, "", "*"));
    expect(names).toContain("INBOX");
    expect(names).toContain("Sent Messages");
    expect(names).toContain("INBOX/accounts");
    expect(names).not.toContain("ZzSubNo");
  });

  it("returns nothing when every user mailbox is unsubscribed except the derived set", async () => {
    const names = namesOf(
      await emit(listSubscribedMailboxes, "", "Zz*", [
        { name: "INBOX", subscribed: true },
        { name: "ZzSubNo", subscribed: false },
      ])
    );
    expect(names).toEqual([]);
  });

  it("computes \\HasChildren against the full set, not the subscribed subset", async () => {
    // The per-account child is unsubscribed; "Sent Messages" must still report
    // \HasChildren, otherwise a client prunes a branch it can still SELECT.
    const lines = await emit(listSubscribedMailboxes, "", "Sent Messages", [
      { name: "Sent Messages", subscribed: true },
      { name: "Sent Messages/accounts", subscribed: false },
      { name: "Sent Messages/accounts/work", subscribed: false },
    ]);
    expect(lines.some((line) => line.includes("(\\HasChildren)"))).toBe(true);
  });

  it("an empty pattern still returns the hierarchy delimiter, no mailboxes", async () => {
    const lines = await emit(listSubscribedMailboxes, "", "");
    expect(lines.some((line) => line.includes('(\\Noselect) "/" ""'))).toBe(true);
    expect(lines.filter((line) => line.startsWith("* LSUB")).length).toBe(1);
  });

  it("applies the reference + pattern on top of the subscription filter", async () => {
    expect(namesOf(await emit(listSubscribedMailboxes, "", "%"))).toEqual(
      expect.arrayContaining(["INBOX", "Sent Messages", "ZzSubYes"])
    );
    expect(namesOf(await emit(listSubscribedMailboxes, "", "%"))).not.toContain(
      "INBOX/accounts"
    );
  });
});
