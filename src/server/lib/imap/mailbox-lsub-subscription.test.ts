
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

  it("takes 'Sent Messages' attributes from the full set even when its children are filtered out", async () => {
    // The ancestor set behind \HasChildren has to be built from the full
    // listable set, not the subscribed subset — otherwise dropping the
    // unsubscribed children would flip the parent to \HasNoChildren and a
    // client would prune a branch it can still SELECT.
    const lines = await emit(listSubscribedMailboxes, "", "Sent Messages", [
      { name: "Sent Messages", subscribed: true },
      { name: "Sent Messages/accounts", subscribed: false },
      { name: "Sent Messages/accounts/work", subscribed: false },
    ]);
    expect(lines.some((line) => line.includes("(\\HasChildren)"))).toBe(true);
  });

  // RFC 3501 §6.3.9. CREATE accepts a "/" in the name (verified against a live
  // server), so a hierarchical user mailbox is reachable — and without this
  // rule, unsubscribing the parent hides the subscribed child from any client
  // that walks the tree with "%".
  describe("an unsubscribed parent of a subscribed child stays visible as \\Noselect", () => {
    const HIER: MailboxEntry[] = [
      { name: "INBOX", subscribed: true },
      { name: "Projects", subscribed: false },
      { name: "Projects/Work", subscribed: true },
    ];

    it('LSUB "" "%" still returns the parent so the subtree is reachable', async () => {
      const names = namesOf(await emit(listSubscribedMailboxes, "", "%", HIER));
      expect(names).toContain("Projects");
    });

    it("marks that parent \\HasChildren \\Noselect, not selectable", async () => {
      const lines = await emit(listSubscribedMailboxes, "", "%", HIER);
      expect(lines).toContainEqual('* LSUB (\\HasChildren \\Noselect) "/" "Projects"\r\n');
    });

    it("drops the parent once no descendant is subscribed", async () => {
      const names = namesOf(
        await emit(listSubscribedMailboxes, "", "%", [
          { name: "Projects", subscribed: false },
          { name: "Projects/Work", subscribed: false },
        ])
      );
      expect(names).toEqual([]);
    });

    it("promotes a grandparent too — every ancestor of a subscribed leaf", async () => {
      // The actual "%" walk: one level per command, each step reachable only
      // because the level above was promoted.
      const DEEP: MailboxEntry[] = [
        { name: "Projects", subscribed: false },
        { name: "Projects/Work", subscribed: false },
        { name: "Projects/Work/Q3", subscribed: true },
      ];
      expect(namesOf(await emit(listSubscribedMailboxes, "", "%", DEEP))).toEqual([
        "Projects",
      ]);
      expect(namesOf(await emit(listSubscribedMailboxes, "", "Projects/%", DEEP))).toEqual([
        "Projects/Work",
      ]);
      expect(
        namesOf(await emit(listSubscribedMailboxes, "", "Projects/Work/%", DEEP))
      ).toEqual(["Projects/Work/Q3"]);
    });

    it("does not promote a name that is only a string prefix, not a path ancestor", async () => {
      const names = namesOf(
        await emit(listSubscribedMailboxes, "", "%", [
          { name: "Project", subscribed: false },
          { name: "Projects/Work", subscribed: true },
        ])
      );
      expect(names).toEqual(["Projects"]);
      expect(names).not.toContain("Project");
    });

    it("promotes an ancestor that has no mailboxes row of its own", async () => {
      // CREATE inserts only the name it is given and never the superior ones
      // (RFC 3501 §6.3.3 says SHOULD, this server does not), so `Projects` can
      // be missing from the listable set entirely while `Projects/Work` is
      // subscribed. Without synthesis a "%"-walker sees INBOX and nothing else.
      const lines = await emit(listSubscribedMailboxes, "", "%", [
        { name: "INBOX", subscribed: true },
        { name: "Projects/Work", subscribed: true },
      ]);
      expect(namesOf(lines).sort()).toEqual(["INBOX", "Projects"]);
      expect(lines).toContainEqual('* LSUB (\\HasChildren \\Noselect) "/" "Projects"\r\n');
    });

    it("reports a SUBSCRIBED parent \\HasChildren too, not \\HasNoChildren", async () => {
      // A "%"-walker honouring \HasNoChildren would descend into the
      // unsubscribed `Projects` above but not into a subscribed one, making
      // the subscribed subtree the unreachable half.
      const lines = await emit(listSubscribedMailboxes, "", "%", [
        { name: "Projects", subscribed: true },
        { name: "Projects/Work", subscribed: true },
      ]);
      expect(lines).toContainEqual('* LSUB (\\HasChildren) "/" "Projects"\r\n');
    });

    it('does not promote under "*" — the walker already gets the descendant', async () => {
      const names = namesOf(await emit(listSubscribedMailboxes, "", "*", HIER));
      expect(names.sort()).toEqual(["INBOX", "Projects/Work"]);
      expect(names).not.toContain("Projects");
    });
  });

  it("an empty pattern still returns the hierarchy delimiter, no mailboxes", async () => {
    const lines = await emit(listSubscribedMailboxes, "", "");
    expect(lines.some((line) => line.includes('(\\Noselect) "/" ""'))).toBe(true);
    expect(lines.filter((line) => line.startsWith("* LSUB")).length).toBe(1);
  });

  it("applies the pattern on top of the subscription filter", async () => {
    expect(namesOf(await emit(listSubscribedMailboxes, "", "%"))).toEqual(
      expect.arrayContaining(["INBOX", "Sent Messages", "ZzSubYes"])
    );
    expect(namesOf(await emit(listSubscribedMailboxes, "", "%"))).not.toContain(
      "INBOX/accounts"
    );
  });

  it("concatenates a non-empty reference with the pattern (RFC 3501 §6.3.8)", async () => {
    // `LSUB "INBOX/" "%"` must behave as the pattern `INBOX/%` — one level
    // below INBOX, not the root level.
    const names = namesOf(await emit(listSubscribedMailboxes, "INBOX/", "%"));
    expect(names).toEqual(["INBOX/accounts"]);
  });

  it("promotes an ancestor under a non-empty reference", async () => {
    // The one shape where the reference concatenation and the ancestor set
    // interact: the promoted name is matched against reference + pattern, so
    // it has to be the full path, not the segment.
    const lines = await emit(listSubscribedMailboxes, "Projects/", "%", [
      { name: "Projects", subscribed: true },
      { name: "Projects/Work", subscribed: false },
      { name: "Projects/Work/Q3", subscribed: true },
    ]);
    expect(namesOf(lines)).toEqual(["Projects/Work"]);
    expect(lines).toContainEqual('* LSUB (\\HasChildren \\Noselect) "/" "Projects/Work"\r\n');
  });
});
