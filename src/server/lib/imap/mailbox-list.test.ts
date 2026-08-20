
import { describe, it, expect } from "bun:test";
import {
  matchesListPattern,
  listMailboxes,
  listSubscribedMailboxes,
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

// A mailbox name is a user-supplied string that reaches the wire as a quoted
// string, exactly like the ENVELOPE values in #762 / #767 — and `createMailbox`
// validates no characters, so `CREATE "a\"b"` stores a name carrying a
// quoted-special. Emitting it raw desyncs LIST/LSUB for the whole session,
// which is worse than the per-message ENVELOPE case: the client cannot list
// mailboxes at all until the row is gone.
describe("LIST / LSUB quote mailbox names (#762 sibling)", () => {
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
