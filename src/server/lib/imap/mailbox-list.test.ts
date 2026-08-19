
import { describe, it, expect } from "bun:test";
import {
  createListPatternMatcher,
  collapseWildcardRuns,
  listMailboxes,
  listSubscribedMailboxes
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
  ({
    listMailboxes: async () => boxes,
    listMailboxEntries: async () =>
      boxes.map((name) => ({ name, subscribed: true })),
  }) as unknown as Store;

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

const attributesFor = async (
  boxes: string[],
  pattern: string = "*"
): Promise<Map<string, string>> => {
  const rows = new Map<string, string>();
  await listMailboxes("A1", "", pattern, fakeStore(boxes), (data: string) => {
    const match = data.match(/^\* LIST \((.*)\) "\/" "(.*)"\r\n$/);
    if (match) rows.set(match[2], match[1]);
    return true;
  });
  return rows;
};

describe("createListPatternMatcher (RFC 3501 §6.3.8)", () => {
  it('"*" matches across the hierarchy delimiter', () => {
    expect(createListPatternMatcher("", "*")("INBOX/accounts/work")).toBe(true);
  });

  it('"%" does not cross the hierarchy delimiter', () => {
    expect(createListPatternMatcher("", "%")("INBOX")).toBe(true);
    expect(createListPatternMatcher("", "%")("INBOX/accounts")).toBe(false);
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

describe("listMailboxes hierarchy attributes (RFC 5258 §3)", () => {
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
    const rows = await attributesFor(TREE, "%");
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

describe("listMailboxes — the attribute and the expansion agree", () => {
  // RFC 5258 §3 exists so a client can decide whether to offer an expand
  // affordance, so every \HasChildren has to be answerable by the `%`
  // expansion of that same name — and every \HasNoChildren by its absence.
  const expansionOf = async (boxes: string[], parent: string): Promise<string[]> =>
    [...(await attributesFor(boxes, `${parent}/%`)).keys()];

  it("a parent with a child: attribute says branch, expansion returns it", async () => {
    const boxes = ["INBOX", "Projects", "Projects/Work"];
    expect((await attributesFor(boxes)).get("Projects")).toBe("\\HasChildren");
    expect(await expansionOf(boxes, "Projects")).toEqual(["Projects/Work"]);
  });

  it("a utility folder with a child: special-use attribute rides alongside", async () => {
    const boxes = ["INBOX", "Drafts", "Drafts/sub"];
    expect((await attributesFor(boxes)).get("Drafts")).toBe("\\Drafts \\HasChildren");
    expect(await expansionOf(boxes, "Drafts")).toEqual(["Drafts/sub"]);
  });

  // RFC 3501 §5.1 makes INBOX case-insensitive as a whole name and leaves
  // every other name case-sensitive, which `createListPatternMatcher` already
  // implements. Ancestry reads names the same way, so a name differing only in
  // the case of its first segment is a different branch of the tree — not a
  // child — and the attribute and the expansion agree on that.
  it("a name differing only in leading-segment case is not a child", async () => {
    const boxes = ["INBOX", "Archive", "archive/old"];
    expect((await attributesFor(boxes)).get("Archive")).toBe("\\HasNoChildren");
    expect(await expansionOf(boxes, "Archive")).toEqual([]);
  });

  it("the same holds for the reserved names, and each is reachable under its own spelling", async () => {
    const boxes = ["INBOX", "Drafts", "inbox/foo", "drafts/sub"];
    const rows = await attributesFor(boxes);
    expect(rows.get("INBOX")).toBe("\\HasNoChildren");
    expect(rows.get("Drafts")).toBe("\\Drafts \\HasNoChildren");
    expect(await expansionOf(boxes, "INBOX")).toEqual([]);
    expect(await expansionOf(boxes, "inbox")).toEqual(["inbox/foo"]);
    expect(await expansionOf(boxes, "drafts")).toEqual(["drafts/sub"]);
  });
});

// A mailbox name is a user-supplied string that reaches the wire as a quoted
// string, exactly like the ENVELOPE values — and `createMailbox` validates no
// characters, so `CREATE "a\"b"` stores a name carrying a quoted-special.
// Emitting it raw desyncs LIST/LSUB for the whole session, which is worse than
// the per-message ENVELOPE case: the client cannot list mailboxes at all until
// the row is gone.
describe("LIST / LSUB quote mailbox names", () => {
  const HOSTILE = ['a"b', "back\\slash", "tail\\"];

  const rawLines = async (
    fn: typeof listMailboxes | typeof listSubscribedMailboxes,
    reference: string,
    pattern: string,
    boxes: string[]
  ): Promise<string[]> => {
    const lines: string[] = [];
    await fn("A1", reference, pattern, fakeStore(boxes), (data: string) => {
      lines.push(data);
      return true;
    });
    return lines;
  };

  // Reads one RFC 3501 quoted string starting at `from`, returning the decoded
  // value. Throws on an unterminated string — the desync signature.
  const readQuoted = (line: string, from: number): string => {
    let i = line.indexOf('"', from);
    if (i < 0) throw new Error("no quoted string");
    i++;
    let out = "";
    for (;;) {
      if (i >= line.length) throw new Error("unterminated quoted string");
      const ch = line[i];
      if (ch === "\\") {
        const next = line[i + 1];
        if (next !== '"' && next !== "\\") throw new Error("illegal escape");
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
      i++;
    }
  };

  // The name is the SECOND quoted string on the line: `* LIST (attrs) "/" "box"`.
  const nameOf = (line: string): string => {
    const delimStart = line.indexOf('"');
    const afterDelim = line.indexOf('"', delimStart + 1) + 1;
    return readQuoted(line, afterDelim);
  };

  it("LIST round-trips a name containing a quote or a backslash", async () => {
    const lines = (await rawLines(listMailboxes, "", "*", HOSTILE)).filter((l) =>
      l.startsWith("* LIST")
    );
    expect(lines).toHaveLength(HOSTILE.length);
    expect(lines.map(nameOf).sort()).toEqual([...HOSTILE].sort());
  });

  it("LSUB round-trips the same names", async () => {
    const lines = (
      await rawLines(listSubscribedMailboxes, "", "*", HOSTILE)
    ).filter((l) => l.startsWith("* LSUB"));
    expect(lines).toHaveLength(HOSTILE.length);
    expect(lines.map(nameOf).sort()).toEqual([...HOSTILE].sort());
  });

  it("quotes the reference echoed back for an empty pattern", async () => {
    const listLines = (await rawLines(listMailboxes, 'ref"x', "", [])).filter(
      (l) => l.startsWith("* LIST")
    );
    expect(listLines).toHaveLength(1);
    expect(readQuoted(listLines[0]!, listLines[0]!.indexOf('"/"') + 3)).toBe(
      'ref"x'
    );

    const lsubLines = (
      await rawLines(listSubscribedMailboxes, 'ref"x', "", [])
    ).filter((l) => l.startsWith("* LSUB"));
    expect(lsubLines).toHaveLength(1);
    expect(readQuoted(lsubLines[0]!, lsubLines[0]!.indexOf('"/"') + 3)).toBe(
      'ref"x'
    );
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
