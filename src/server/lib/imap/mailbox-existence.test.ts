/**
 * Tests for mailbox-existence validation on SELECT / EXAMINE / STATUS (#595).
 *
 * Before the fix, all three commands detected non-existence solely via
 * `countMessages(...) === null`, but countMessages returns a zero-count
 * aggregate (never null) for an unknown name — so every invented mailbox
 * "succeeded" as a valid-but-empty mailbox. RFC 3501 §6.3.1/2/10 require a
 * tagged NO for a non-existent mailbox. These cases pin: NO for an unknown
 * name across SELECT/EXAMINE/STATUS, and OK for a real (existing-but-empty)
 * mailbox.
 *
 * Uses a fake Store (the mailbox-list.test.ts pattern) so no DB is touched.
 * The STATUS OK case requests no UIDVALIDITY item, so statusMailbox never
 * reaches getImapUidValidity.
 */

import { describe, it, expect } from "bun:test";
import { selectMailbox, statusMailbox } from "./mailbox-ops";
import { Store } from "./store";
import type { SignedUser } from "common";
import type { SequenceState } from "./sequence-resolver";

const REAL_MAILBOXES = ["INBOX", "Sent Messages", "Archive"];

// mailboxExists consults listMailboxes(); countMessages backs the STATUS OK
// path (an existing-but-empty mailbox aggregates to total 0). mailboxExists
// mirrors the Store contract so the handler gate is exercised end-to-end; the
// real Store.mailboxExists is unit-tested separately below.
const fakeStore = (boxes: string[]): Store =>
  ({
    listMailboxes: async () => boxes,
    mailboxExists: async (box: string) => box === "INBOX" || boxes.includes(box),
    countMessages: async () => ({ total: 0, unread: 0, maxUid: 0 }),
  }) as unknown as Store;

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

const runSelect = async (name: string, readOnly: boolean) => {
  const lines: string[] = [];
  await selectMailbox(
    "A1",
    name,
    readOnly,
    fakeStore(REAL_MAILBOXES),
    (data: string) => {
      lines.push(data);
      return true;
    },
    emptySeqState(),
    () => {},
    () => {}
  );
  return lines;
};

const runStatus = async (mailbox: string) => {
  const lines: string[] = [];
  await statusMailbox(
    "A1",
    mailbox,
    ["MESSAGES", "UIDNEXT", "UNSEEN"],
    fakeStore(REAL_MAILBOXES),
    (data: string) => {
      lines.push(data);
      return true;
    }
  );
  return lines;
};

describe("mailbox-existence validation (#595)", () => {
  it("SELECT on an unknown mailbox returns NO and no EXISTS", async () => {
    const lines = await runSelect("ThisMailboxDoesNotExist", false);
    expect(lines).toEqual(["A1 NO Mailbox does not exist\r\n"]);
    expect(lines.some((l) => l.includes("EXISTS"))).toBe(false);
  });

  it("EXAMINE on an unknown mailbox returns NO and no EXISTS", async () => {
    const lines = await runSelect("NopeNotHere", true);
    expect(lines).toEqual(["A1 NO Mailbox does not exist\r\n"]);
    expect(lines.some((l) => l.includes("EXISTS"))).toBe(false);
  });

  it("SELECT on a per-account box for a non-existent account returns NO", async () => {
    const lines = await runSelect(
      "INBOX/accounts/zzz-no-such-account",
      false
    );
    expect(lines).toEqual(["A1 NO Mailbox does not exist\r\n"]);
  });

  it("STATUS on an unknown mailbox returns NO and no untagged STATUS", async () => {
    const lines = await runStatus("GarbageBox");
    expect(lines).toEqual(["A1 NO Mailbox does not exist\r\n"]);
    expect(lines.some((l) => l.startsWith("* STATUS"))).toBe(false);
  });

  it("STATUS on a real (empty) mailbox still returns OK with a STATUS line", async () => {
    const lines = await runStatus("Archive");
    expect(lines).toContain(
      '* STATUS "Archive" (MESSAGES 0 UIDNEXT 1 UNSEEN 0)\r\n'
    );
    expect(lines).toContain("A1 OK STATUS completed\r\n");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
  });

  it("INBOX always validates as existing", async () => {
    // Even with an empty list (e.g. a brand-new account), INBOX must exist.
    const lines: string[] = [];
    await statusMailbox(
      "A1",
      "INBOX",
      ["MESSAGES"],
      fakeStore([]),
      (data: string) => {
        lines.push(data);
        return true;
      }
    );
    expect(lines).toContain("A1 OK STATUS completed\r\n");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
  });
});

describe("Store.mailboxExists (#595)", () => {
  // The constructor only stashes the user (no DB), so we can build a real
  // Store and override its list methods to exercise the real mailboxExists.
  // `mailboxExists` consults `listMailboxesOrThrow` (the throwing path —
  // see #601) so transient backend errors propagate instead of getting
  // swallowed into a false "does not exist." We patch both — the public
  // `listMailboxes` (for any consumer reading it directly) and the private
  // `listMailboxesOrThrow` (what `mailboxExists` actually calls).
  const makeStore = (boxes: string[]): Store => {
    const store = new Store({ id: "u1", username: "admin" } as SignedUser);
    store.listMailboxes = async () => boxes;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).listMailboxesOrThrow = async () => boxes;
    return store;
  };

  it("returns true for INBOX without consulting the list", async () => {
    const store = new Store({ id: "u1", username: "admin" } as SignedUser);
    const guard = async () => {
      throw new Error("list path should not be called for INBOX");
    };
    store.listMailboxes = guard;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).listMailboxesOrThrow = guard;
    expect(await store.mailboxExists("INBOX")).toBe(true);
  });

  it("returns true for a listed mailbox", async () => {
    const store = makeStore(REAL_MAILBOXES);
    expect(await store.mailboxExists("Sent Messages")).toBe(true);
    expect(await store.mailboxExists("Archive")).toBe(true);
  });

  it("returns false for an unlisted name", async () => {
    const store = makeStore(REAL_MAILBOXES);
    expect(await store.mailboxExists("GarbageBox")).toBe(false);
  });
});
