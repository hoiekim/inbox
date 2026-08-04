/**
 * The IMAP surface of the utility mailboxes (#725).
 *
 * `Drafts` and `Junk` are server-defined views, not rows in `mailboxes`. That
 * makes them behave like INBOX for every command that manipulates the mailbox
 * itself: they always exist, so CREATE is a conflict, and there is nothing
 * behind them to DELETE or RENAME. Without the guards the DB layer answers each
 * of those with `[NONEXISTENT] Mailbox does not exist` — for a box the client
 * can see in its own LIST output.
 *
 * The row-level half of the feature (which mails each view holds) lives in
 * `repositories/mails/views.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  isDomainScoped,
  isUtilityFolder,
  utilityPlacement,
  UTILITY_FOLDERS,
} from "./util";
import {
  createMailbox,
  deleteMailbox,
  renameMailbox,
  getMailboxAttributes,
} from "./mailbox-ops";
import { Store } from "./store";
import type { SignedUser } from "common";

const NAMES = UTILITY_FOLDERS.map((folder) => folder.name);

const makeStore = (): Store =>
  new Store({ id: "u1", username: "admin" } as SignedUser);

const run = async (
  op: (write: (data: string) => boolean) => Promise<void>
): Promise<string[]> => {
  const lines: string[] = [];
  await op((data: string) => {
    lines.push(data);
    return true;
  });
  return lines;
};

describe("isUtilityFolder", () => {
  it("matches the defined names exactly", () => {
    expect(isUtilityFolder("Drafts")).toBe(true);
    expect(isUtilityFolder("Junk")).toBe(true);
  });

  it("is case-insensitive, matching the LIST de-dup", () => {
    // `Store.listMailboxesOrThrow` de-dups user boxes against these names
    // case-insensitively, so `drafts` names no listable box. An exact-case
    // guard would let `CREATE "drafts"` write a row that LIST then hides and
    // SELECT then rejects — the phantom the CREATE guard exists to prevent.
    expect(isUtilityFolder("drafts")).toBe(true);
    expect(isUtilityFolder("JUNK")).toBe(true);
  });

  it("matches the whole name — not a prefix, suffix, or substring", () => {
    // `INBOX/accounts/junk` is a real per-account box in prod (a user whose
    // local-part is `junk`). A substring match would swallow it.
    expect(isUtilityFolder("INBOX/accounts/junk")).toBe(false);
    expect(isUtilityFolder("Drafts2")).toBe(false);
    expect(isUtilityFolder("INBOX/Drafts")).toBe(false);
    expect(isUtilityFolder("Drafts/sub")).toBe(false);
    expect(isUtilityFolder("")).toBe(false);
  });

  it("puts every utility folder in the domain UID space", () => {
    for (const name of NAMES) expect(isDomainScoped(name)).toBe(true);
  });
});

describe("LIST attributes", () => {
  it("reports the RFC 6154 special-use attribute", () => {
    expect(getMailboxAttributes("Drafts", NAMES)).toBe("\\Drafts \\HasNoChildren");
    expect(getMailboxAttributes("Junk", NAMES)).toBe("\\Junk \\HasNoChildren");
  });

  it("leaves every other box's attributes alone", () => {
    expect(getMailboxAttributes("Archive", ["Archive"])).toBe("\\HasNoChildren");
    expect(getMailboxAttributes("INBOX/accounts", ["INBOX/accounts"])).toBe(
      "\\HasChildren \\Noselect"
    );
  });
});

describe("CREATE / DELETE / RENAME against a utility folder", () => {
  it("CREATE reports the conflict, not a DB insert", async () => {
    for (const name of NAMES) {
      const lines = await run((write) => createMailbox("A1", name, makeStore(), write));
      expect(lines).toEqual(["A1 NO [ALREADYEXISTS] Mailbox already exists\r\n"]);
    }
  });

  it("DELETE refuses instead of reporting a missing mailbox", async () => {
    for (const name of NAMES) {
      const lines = await run((write) => deleteMailbox("A1", name, makeStore(), write));
      expect(lines).toEqual(["A1 NO [CANNOT] Cannot delete system mailbox\r\n"]);
    }
  });

  it("RENAME refuses as source and as target", async () => {
    for (const name of NAMES) {
      expect(
        await run((write) => renameMailbox("A1", name, "Elsewhere", makeStore(), write))
      ).toEqual(["A1 NO [CANNOT] Cannot rename system mailbox\r\n"]);
      expect(
        await run((write) => renameMailbox("A1", "Archive", name, makeStore(), write))
      ).toEqual(["A1 NO [ALREADYEXISTS] Target mailbox already exists\r\n"]);
    }
  });
});

describe("utilityPlacement", () => {
  it("returns the flag a write into the box must set", () => {
    expect(utilityPlacement("Drafts")).toEqual({ draft: true });
    expect(utilityPlacement("Junk")).toEqual({ is_spam: true });
  });

  it("returns nothing for any other box", () => {
    expect(utilityPlacement("Archive")).toBeUndefined();
    expect(utilityPlacement("INBOX")).toBeUndefined();
  });
});
