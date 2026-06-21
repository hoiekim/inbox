/**
 * Tests for LIST/LSUB reference + pattern handling (#596).
 *
 * Before the fix, listMailboxes ignored both arguments and emitted the entire
 * mailbox tree for every query. These cases pin the RFC 3501 §6.3.8 wildcard
 * semantics ("*" crosses the "/" delimiter, "%" stays within one level) and the
 * handler's filtering of the box set against reference + pattern.
 */

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
