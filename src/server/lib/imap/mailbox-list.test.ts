
import { describe, it, expect } from "bun:test";
import { matchesListPattern, listMailboxes } from "./mailbox-ops";
import type { Store } from "./store";

const TREE = [
  "INBOX",
  "Sent Messages",
  "INBOX/accounts",
  "INBOX/accounts/work",
  "INBOX/accounts/personal",
  "Archive"
];

const fakeStore = (boxes: string[]): Store =>
  ({ listMailboxes: async () => boxes }) as unknown as Store;

const listed = async (reference: string, pattern: string): Promise<string[]> => {
  const lines: string[] = [];
  await listMailboxes(
    "A1",
    reference,
    pattern,
    fakeStore(TREE),
    (data: string) => {
      lines.push(data);
      return true;
    }
  );
  return lines
    .filter((l) => l.startsWith("* LIST"))
    .map((l) => l.replace(/.*"\/" "(.*)"\r\n$/, "$1"));
};

describe("matchesListPattern (RFC 3501 §6.3.8)", () => {
  it('"*" matches across the hierarchy delimiter', () => {
    expect(matchesListPattern("", "*", "INBOX/accounts/work")).toBe(true);
  });

  it('"%" does not cross the hierarchy delimiter', () => {
    expect(matchesListPattern("", "%", "INBOX")).toBe(true);
    expect(matchesListPattern("", "%", "INBOX/accounts")).toBe(false);
  });

  it("an exact name with no wildcard matches only itself", () => {
    expect(matchesListPattern("", "INBOX", "INBOX")).toBe(true);
    expect(matchesListPattern("", "INBOX", "INBOX/accounts")).toBe(false);
    expect(matchesListPattern("", "INBOX", "Sent Messages")).toBe(false);
  });

  it('"%" after a path segment matches one further level only', () => {
    expect(matchesListPattern("", "INBOX/%", "INBOX/accounts")).toBe(true);
    expect(matchesListPattern("", "INBOX/%", "INBOX/accounts/work")).toBe(false);
  });

  it("concatenates a non-empty reference with the pattern", () => {
    expect(matchesListPattern("INBOX/", "%", "INBOX/accounts")).toBe(true);
    expect(matchesListPattern("INBOX/", "%", "Archive")).toBe(false);
  });
});

describe("listMailboxes filtering (#596)", () => {
  it('LIST "" "%" returns top-level names only', async () => {
    const result = await listed("", "%");
    expect(result.sort()).toEqual(
      ["Archive", "INBOX", "Sent Messages"].sort()
    );
    expect(result).not.toContain("INBOX/accounts");
    expect(result).not.toContain("INBOX/accounts/work");
  });

  it('LIST "" "INBOX" returns exactly the one entry', async () => {
    expect(await listed("", "INBOX")).toEqual(["INBOX"]);
  });

  it('LIST "" "*" returns the full tree', async () => {
    expect((await listed("", "*")).sort()).toEqual([...TREE].sort());
  });

  it('LIST "" "%/accounts" returns only the ".../accounts" parents', async () => {
    expect(await listed("", "%/accounts")).toEqual(["INBOX/accounts"]);
  });

  it("an empty pattern returns the hierarchy delimiter, no mailboxes", async () => {
    const lines: string[] = [];
    await listMailboxes("A1", "", "", fakeStore(TREE), (data: string) => {
      lines.push(data);
      return true;
    });
    expect(lines.some((l) => l.includes('(\\Noselect) "/" ""'))).toBe(true);
    expect(lines.filter((l) => l.startsWith("* LIST")).length).toBe(1);
  });
});

describe("listMailboxes hierarchy attributes (RFC 5258 §3)", () => {
  const attributesFor = async (boxes: string[]): Promise<Map<string, string>> => {
    const rows = new Map<string, string>();
    await listMailboxes("A1", "", "*", fakeStore(boxes), (data: string) => {
      const match = data.match(/^\* LIST \((.*)\) "\/" "(.*)"\r\n$/);
      if (match) rows.set(match[2], match[1]);
      return true;
    });
    return rows;
  };

  it("reports a user-created parent \\HasChildren", async () => {
    const rows = await attributesFor(["INBOX", "Projects", "Projects/Work"]);
    expect(rows.get("Projects")).toBe("\\HasChildren");
    expect(rows.get("Projects/Work")).toBe("\\HasNoChildren");
  });

  it("reports INBOX \\HasChildren once the accounts tree exists", async () => {
    const rows = await attributesFor(TREE);
    expect(rows.get("INBOX")).toBe("\\HasChildren");
    expect(rows.get("INBOX/accounts")).toBe("\\HasChildren \\Noselect");
    expect(rows.get("INBOX/accounts/work")).toBe("\\HasNoChildren");
    expect(rows.get("Archive")).toBe("\\HasNoChildren");
  });

  it("keeps a parent \\HasChildren when the pattern filters its children out", async () => {
    const rows = new Map<string, string>();
    await listMailboxes("A1", "", "%", fakeStore(TREE), (data: string) => {
      const match = data.match(/^\* LIST \((.*)\) "\/" "(.*)"\r\n$/);
      if (match) rows.set(match[2], match[1]);
      return true;
    });
    expect([...rows.keys()].sort()).toEqual(["Archive", "INBOX", "Sent Messages"]);
    expect(rows.get("INBOX")).toBe("\\HasChildren");
  });

  it("does not treat a mere string prefix as a parent", async () => {
    const rows = await attributesFor(["INBOX", "Project", "Projects/Work"]);
    expect(rows.get("Project")).toBe("\\HasNoChildren");
  });

  it("derives 'Sent Messages' from its own child, not from a hardcoded name", async () => {
    const withAccounts = await attributesFor([
      "INBOX",
      "Sent Messages",
      "Sent Messages/accounts",
      "Sent Messages/accounts/work"
    ]);
    expect(withAccounts.get("Sent Messages")).toBe("\\HasChildren");
    const bare = await attributesFor(["INBOX", "Sent Messages"]);
    expect(bare.get("Sent Messages")).toBe("\\HasNoChildren");
  });
});

describe("listMailboxes hierarchy attributes — case-insensitive names", () => {
  const attributesFor = async (boxes: string[]): Promise<Map<string, string>> => {
    const rows = new Map<string, string>();
    await listMailboxes("A1", "", "*", fakeStore(boxes), (data: string) => {
      const match = data.match(/^\* LIST \((.*)\) "\/" "(.*)"\r\n$/);
      if (match) rows.set(match[2], match[1]);
      return true;
    });
    return rows;
  };

  it("parents INBOX from a child CREATEd under the lowercase spelling", async () => {
    const rows = await attributesFor(["INBOX", "inbox/foo"]);
    expect(rows.get("INBOX")).toBe("\\HasChildren");
  });

  it("parents a utility folder from a child CREATEd under a different case", async () => {
    const rows = await attributesFor(["INBOX", "Drafts", "drafts/sub"]);
    expect(rows.get("Drafts")).toBe("\\Drafts \\HasChildren");
  });

  it("leaves an ordinary name case-sensitive, per RFC 3501 §5.1", async () => {
    const rows = await attributesFor(["INBOX", "Archive", "archive/old"]);
    expect(rows.get("Archive")).toBe("\\HasNoChildren");
  });
});
