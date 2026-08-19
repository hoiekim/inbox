
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

  it('a "%" that stalls at the delimiter lets an earlier "*" absorb it', () => {
    expect(matchesListPattern("", "*%b", "a/b")).toBe(true);
    expect(matchesListPattern("", "*/%", "INBOX/accounts")).toBe(true);
    expect(matchesListPattern("", "*/%", "INBOX/accounts/work")).toBe(true);
    expect(matchesListPattern("", "*/%", "Archive")).toBe(false);
  });

  it("interleaved wildcards and literals match by position", () => {
    expect(matchesListPattern("", "*a*b*", "xxaybzz")).toBe(true);
    expect(matchesListPattern("", "*a*b*", "xxbyazz")).toBe(false);
    expect(matchesListPattern("", "%a%", "za/b")).toBe(false);
    expect(matchesListPattern("", "*a%", "za/b")).toBe(false);
    expect(matchesListPattern("", "*a*", "za/b")).toBe(true);
  });

  it("regex metacharacters in a pattern stay literal", () => {
    expect(matchesListPattern("", "a.c", "abc")).toBe(false);
    expect(matchesListPattern("", "a.c", "a.c")).toBe(true);
    expect(matchesListPattern("", "a+", "aa")).toBe(false);
    expect(matchesListPattern("", "a+", "a+")).toBe(true);
  });

  it("an empty concatenated pattern matches only an empty name", () => {
    expect(matchesListPattern("", "", "")).toBe(true);
    expect(matchesListPattern("", "", "INBOX")).toBe(false);
  });
});

describe("matchesListPattern cost is bounded by pattern x name (#856)", () => {
  // The pattern below took 195 s against this name when the matcher compiled
  // client input into a backtracking regex: ten unbounded quantifiers with a
  // literal between each pair, and a trailing character that never matches, so
  // the engine had to exhaust every way of distributing the "a"s before
  // failing. These cases assert a wall-clock bound, because a matcher that
  // merely returns the right answer would pass the cases above either way.
  const LONG_NAME = `INBOX/accounts/${"a".repeat(60)}`;
  const BUDGET_MS = 1000;

  const elapsed = (run: () => void): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it("a failing alternation of wildcards and literals returns promptly", () => {
    let result = true;
    const took = elapsed(() => {
      result = matchesListPattern("", `${"*a".repeat(10)}!`, LONG_NAME);
    });
    expect(result).toBe(false);
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it("a long run of wildcards returns promptly", () => {
    let result = false;
    const took = elapsed(() => {
      result = matchesListPattern("", "*".repeat(10_000), LONG_NAME);
    });
    expect(result).toBe(true);
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it("a long mixed wildcard run returns promptly and keeps its semantics", () => {
    let crossesDelimiter = false;
    const took = elapsed(() => {
      crossesDelimiter = matchesListPattern("", "%*%".repeat(3_000), LONG_NAME);
    });
    expect(crossesDelimiter).toBe(true);
    expect(matchesListPattern("", "%%%", "INBOX/accounts")).toBe(false);
    expect(took).toBeLessThan(BUDGET_MS);
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
