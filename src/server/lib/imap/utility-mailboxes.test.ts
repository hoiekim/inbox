
import { describe, it, expect } from "bun:test";
import {
  canonicalMailbox,
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
    expect(isUtilityFolder("Starred")).toBe(true);
    expect(isUtilityFolder("Trash")).toBe(true);
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

  it("splits utility folders by uidSpace: Drafts/Junk domain-scoped, Starred/Trash mapped", () => {
    expect(isDomainScoped("Drafts")).toBe(true);
    expect(isDomainScoped("Junk")).toBe(true);
    expect(isDomainScoped("Starred")).toBe(false);
    expect(isDomainScoped("Trash")).toBe(false);
    // All four remain utility folders — same LIST/CREATE/RENAME semantics.
    for (const name of NAMES) expect(isUtilityFolder(name)).toBe(true);
  });
});

describe("canonicalMailbox", () => {
  it("resolves a utility name to its listed spelling", () => {
    // The guards match case-insensitively but `mailboxExists` compares against
    // the LIST names exactly, so without this every entry point would refuse
    // `drafts` as both already-existing (CREATE) and non-existent (SELECT).
    expect(canonicalMailbox("drafts")).toBe("Drafts");
    expect(canonicalMailbox("JUNK")).toBe("Junk");
  });

  it("still canonicalizes INBOX and leaves every other name alone", () => {
    expect(canonicalMailbox("inbox")).toBe("INBOX");
    expect(canonicalMailbox("Archive")).toBe("Archive");
    expect(canonicalMailbox("Drafts/sub")).toBe("Drafts/sub");
    expect(canonicalMailbox("INBOX/accounts/junk")).toBe("INBOX/accounts/junk");
  });
});

describe("LIST attributes", () => {
  it("reports the RFC 6154 special-use attribute", () => {
    expect(getMailboxAttributes("Drafts", NAMES)).toBe("\\Drafts \\HasNoChildren");
    expect(getMailboxAttributes("Junk", NAMES)).toBe("\\Junk \\HasNoChildren");
    expect(getMailboxAttributes("Starred", NAMES)).toBe("\\Flagged \\HasNoChildren");
    expect(getMailboxAttributes("Trash", NAMES)).toBe("\\Trash \\HasNoChildren");
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
    expect(utilityPlacement("Starred")).toEqual({ saved: true });
    expect(utilityPlacement("Trash")).toEqual({ deleted: true });
  });

  it("returns nothing for any other box", () => {
    expect(utilityPlacement("Archive")).toBeUndefined();
    expect(utilityPlacement("INBOX")).toBeUndefined();
  });

  it("returns distinct flag mappings — no accidental sibling copy-paste", () => {
    // The four utility folders each map to a DIFFERENT flag. A future
    // config edit that miscopies a sibling's placement (e.g. Starred's
    // `saved: true` gets replaced with `deleted: true` — cursor drift while
    // editing UTILITY_FOLDERS) would land stars in the Trash view. Pin the
    // shape so a mis-copy fails a test rather than just the sandbox.
    const placements = [
      utilityPlacement("Drafts"),
      utilityPlacement("Junk"),
      utilityPlacement("Starred"),
      utilityPlacement("Trash"),
    ];
    const keys = placements.map((p) => Object.keys(p ?? {}).join(","));
    expect(new Set(keys).size).toBe(placements.length);
  });
});
