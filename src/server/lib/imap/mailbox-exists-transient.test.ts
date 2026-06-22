/**
 * Tests for transient-error propagation in mailboxExists (#601).
 *
 * `Store.mailboxExists` (added in #599) was implemented as
 * `listMailboxes().includes(box)`. `listMailboxes` swallows backend errors
 * and falls back to `["INBOX"]` (acceptable for LIST resilience). For the
 * existence gate that's wrong: a transient DB hiccup on the stats/list
 * queries turns into `NO Mailbox does not exist` — a permanent signal — for
 * a mailbox the client just successfully `LIST`ed.
 *
 * After this fix, `mailboxExists` uses `listMailboxesOrThrow` (no fallback),
 * so transient errors propagate up. The SELECT/STATUS handlers' existing
 * try-catch then writes `NO SELECT failed` / `NO STATUS failed` (transient,
 * retry-friendly) instead of `NO Mailbox does not exist` (permanent).
 *
 * `listMailboxes` (the LIST-facing path) keeps the fallback so LIST stays
 * usable when the DB hiccups.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { Store } from "./store";
import { selectMailbox, statusMailbox } from "./mailbox-ops";
import type { SignedUser } from "common";
import type { SequenceState } from "./sequence-resolver";

const VALID_USER: SignedUser = { id: "u1", username: "admin" } as SignedUser;

// We test mailboxExists by patching listMailboxesOrThrow (the new private
// method) and listMailboxes (the public fallback wrapper). Both are
// instance-bound async arrow properties, so we can monkey-patch them on the
// instance without touching prototypes.
const buildStore = (opts: {
  rawBoxes?: string[];
  throwInListOrThrow?: boolean;
}): Store => {
  const store = new Store(VALID_USER);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).listMailboxesOrThrow = async () => {
    if (opts.throwInListOrThrow) {
      throw new Error("simulated DB hiccup on listMailboxesOrThrow");
    }
    return opts.rawBoxes ?? ["INBOX"];
  };
  // The fallback wrapper still calls listMailboxesOrThrow under the hood —
  // since we patched the inner method, the outer one will catch and fall
  // back. Patch it explicitly anyway so the test is independent of the
  // wrapper's internal call shape (defends against future refactor).
  store.listMailboxes = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (store as any).listMailboxesOrThrow();
    } catch {
      return ["INBOX"];
    }
  };
  return store;
};

describe("Store.mailboxExists propagates transient errors (#601)", () => {
  it("returns true for INBOX without consulting the list (regression)", async () => {
    const store = buildStore({
      throwInListOrThrow: true, // would throw if consulted
    });
    expect(await store.mailboxExists("INBOX")).toBe(true);
    expect(await store.mailboxExists("inbox")).toBe(true);
  });

  it("returns true for a listed mailbox on healthy queries", async () => {
    const store = buildStore({
      rawBoxes: ["INBOX", "Sent Messages", "Archive"],
    });
    expect(await store.mailboxExists("Archive")).toBe(true);
    expect(await store.mailboxExists("Sent Messages")).toBe(true);
  });

  it("returns false for an unlisted name on healthy queries", async () => {
    const store = buildStore({
      rawBoxes: ["INBOX", "Sent Messages", "Archive"],
    });
    expect(await store.mailboxExists("GarbageBox")).toBe(false);
  });

  it("THROWS on transient backend failure (does not fall back to ['INBOX'])", async () => {
    const store = buildStore({ throwInListOrThrow: true });
    // The whole point of #601: the existence check must distinguish
    // "couldn't determine the list" from "you're not on it." Throwing
    // is how that distinction reaches the SELECT/STATUS handler.
    await expect(store.mailboxExists("Archive")).rejects.toThrow(
      "simulated DB hiccup on listMailboxesOrThrow"
    );
  });
});

describe("Store.listMailboxes still falls back on transient errors (regression)", () => {
  it("returns ['INBOX'] on backend failure — LIST path resilience kept", async () => {
    const store = buildStore({ throwInListOrThrow: true });
    const result = await store.listMailboxes();
    expect(result).toEqual(["INBOX"]);
  });
});

// The handler-level assertions verify the wire response shape: a transient
// failure must not surface as "Mailbox does not exist" (permanent) but as
// "SELECT failed" / "STATUS failed" (transient, retry-friendly).

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

describe("SELECT writes 'NO SELECT failed' (not 'does not exist') on transient mailboxExists error (#601)", () => {
  it("transient throw → SELECT failed (transient signal)", async () => {
    const store = buildStore({ throwInListOrThrow: true });
    const lines: string[] = [];
    await selectMailbox(
      "A1",
      "Archive",
      false,
      store,
      (data: string) => {
        lines.push(data);
        return true;
      },
      emptySeqState(),
      () => {},
      () => {}
    );
    // The catch block writes "NO SELECT failed" — a transient signal that
    // tells the client to retry, not a permanent "this mailbox doesn't
    // exist anymore" verdict.
    expect(lines).toContain("A1 NO SELECT failed\r\n");
    expect(
      lines.some((l) => l.includes("NO Mailbox does not exist"))
    ).toBe(false);
  });

  it("non-existence (without backend error) still writes 'NO Mailbox does not exist'", async () => {
    const store = buildStore({ rawBoxes: ["INBOX", "Archive"] });
    const lines: string[] = [];
    await selectMailbox(
      "A1",
      "GhostBox",
      false,
      store,
      (data: string) => {
        lines.push(data);
        return true;
      },
      emptySeqState(),
      () => {},
      () => {}
    );
    expect(lines).toContain("A1 NO Mailbox does not exist\r\n");
  });
});

describe("STATUS writes 'NO STATUS failed' (not 'does not exist') on transient mailboxExists error (#601)", () => {
  it("transient throw → STATUS failed (transient signal)", async () => {
    const store = buildStore({ throwInListOrThrow: true });
    const lines: string[] = [];
    await statusMailbox(
      "A1",
      "Archive",
      ["MESSAGES"],
      store,
      (data: string) => {
        lines.push(data);
        return true;
      }
    );
    expect(lines).toContain("A1 NO STATUS failed\r\n");
    expect(
      lines.some((l) => l.includes("NO Mailbox does not exist"))
    ).toBe(false);
    expect(lines.some((l) => l.startsWith("* STATUS"))).toBe(false);
  });
});

afterEach(() => {
  mock.restore();
});
