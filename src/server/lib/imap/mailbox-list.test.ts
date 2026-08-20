
import { describe, it, expect } from "bun:test";
import {
  createListPatternMatcher,
  collapseWildcardRuns,
  listMailboxes
} from "./mailbox-ops";
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

describe("createListPatternMatcher (RFC 3501 §6.3.8)", () => {
  it('"*" matches across the hierarchy delimiter', () => {
    expect(createListPatternMatcher("", "*")("INBOX/accounts/work")).toBe(true);
  });

  it('"%" does not cross the hierarchy delimiter', () => {
    expect(createListPatternMatcher("", "%")("INBOX")).toBe(true);
    expect(createListPatternMatcher("", "%")("INBOX/accounts")).toBe(false);
  });

  it("the INBOX fold applies to the stored name, not just the pattern", () => {
    // store.ts dedups mailbox names case-sensitively, so a legacy lowercase
    // "inbox" row can be listed alongside the synthetic canonical one.
    expect(createListPatternMatcher("", "INBOX")("inbox")).toBe(true);
    expect(createListPatternMatcher("", "inbox")("inbox")).toBe(true);
  });

  it("an exact name with no wildcard matches only itself", () => {
    expect(createListPatternMatcher("", "INBOX")("INBOX")).toBe(true);
    expect(createListPatternMatcher("", "INBOX")("INBOX/accounts")).toBe(false);
    expect(createListPatternMatcher("", "INBOX")("Sent Messages")).toBe(false);
  });

  it('"%" after a path segment matches one further level only', () => {
    expect(createListPatternMatcher("", "INBOX/%")("INBOX/accounts")).toBe(true);
    expect(createListPatternMatcher("", "INBOX/%")("INBOX/accounts/work")).toBe(false);
  });

  it("concatenates a non-empty reference with the pattern", () => {
    expect(createListPatternMatcher("INBOX/", "%")("INBOX/accounts")).toBe(true);
    expect(createListPatternMatcher("INBOX/", "%")("Archive")).toBe(false);
  });

  it('a "%" that stalls at the delimiter lets an earlier "*" absorb it', () => {
    // "*" has to give up "xa/" to the earlier position before "%" can match
    // within the last segment; a matcher that only ever retries its most
    // recent wildcard reports false here.
    expect(createListPatternMatcher("", "*a%b")("xa/ab")).toBe(true);
    expect(createListPatternMatcher("", "*a%b")("xa/ab/c")).toBe(false);
    expect(createListPatternMatcher("", "*/%")("INBOX/accounts")).toBe(true);
    expect(createListPatternMatcher("", "*/%")("INBOX/accounts/work")).toBe(true);
    expect(createListPatternMatcher("", "*/%")("Archive")).toBe(false);
  });

  it("interleaved wildcards and literals match by position", () => {
    expect(createListPatternMatcher("", "*a*b*")("xxaybzz")).toBe(true);
    expect(createListPatternMatcher("", "*a*b*")("xxbyazz")).toBe(false);
    expect(createListPatternMatcher("", "%a%")("za/b")).toBe(false);
    expect(createListPatternMatcher("", "*a%")("za/b")).toBe(false);
    expect(createListPatternMatcher("", "*a*")("za/b")).toBe(true);
  });

  it("regex metacharacters in a pattern stay literal", () => {
    expect(createListPatternMatcher("", "a.c")("abc")).toBe(false);
    expect(createListPatternMatcher("", "a.c")("a.c")).toBe(true);
    expect(createListPatternMatcher("", "a+")("aa")).toBe(false);
    expect(createListPatternMatcher("", "a+")("a+")).toBe(true);
  });

  it("an empty concatenated pattern matches only an empty name", () => {
    expect(createListPatternMatcher("", "")("")).toBe(true);
    expect(createListPatternMatcher("", "")("INBOX")).toBe(false);
  });
});

describe("createListPatternMatcher cost is bounded by pattern x name (#856)", () => {
  // A LIST pattern is client input on a single-threaded process, so a matcher
  // that returns the right answer slowly is a denial of service. These cases
  // assert a wall-clock bound because no assertion on the result can.
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
      result = createListPatternMatcher("", `${"*a".repeat(10)}!`)(LONG_NAME);
    });
    expect(result).toBe(false);
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it("a long run of wildcards returns promptly", () => {
    let result = false;
    const took = elapsed(() => {
      result = createListPatternMatcher("", "*".repeat(10_000))(LONG_NAME);
    });
    expect(result).toBe(true);
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it("a long mixed wildcard run returns promptly and keeps its semantics", () => {
    let crossesDelimiter = false;
    const took = elapsed(() => {
      crossesDelimiter = createListPatternMatcher("", "%*%".repeat(3_000))(LONG_NAME);
    });
    expect(crossesDelimiter).toBe(true);
    expect(createListPatternMatcher("", "%%%")("INBOX/accounts")).toBe(false);
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

describe("collapseWildcardRuns", () => {
  it("reduces a mixed run to the delimiter-crossing wildcard", () => {
    expect(collapseWildcardRuns("%*%")).toBe("*");
    expect(collapseWildcardRuns("*%")).toBe("*");
    expect(collapseWildcardRuns("%*")).toBe("*");
    expect(collapseWildcardRuns("**")).toBe("*");
  });

  it("reduces a run of only \"%\" to one \"%\"", () => {
    expect(collapseWildcardRuns("%%")).toBe("%");
    expect(collapseWildcardRuns("%%%%")).toBe("%");
  });

  it("keeps runs separated by a literal apart", () => {
    expect(collapseWildcardRuns("%%a%%")).toBe("%a%");
    expect(collapseWildcardRuns("a**%b")).toBe("a*b");
    expect(collapseWildcardRuns("*a*a*")).toBe("*a*a*");
  });

  it("leaves a wildcard-free pattern untouched", () => {
    expect(collapseWildcardRuns("")).toBe("");
    expect(collapseWildcardRuns("INBOX/accounts")).toBe("INBOX/accounts");
  });
});
