/**
 * Tests for message-ops.ts — IMAP message operations.
 *
 * Regression coverage for inbox #543: STORE on a UID/sequence range that
 * matches no messages must send exactly ONE tagged response (OK, not NO).
 * The old code wrote a tagged NO and threw on an empty result, and the
 * surrounding catch block then wrote a SECOND tagged NO — two tagged
 * responses for a single command, which desynchronizes IMAP clients
 * (RFC 3501 §2.2.1 requires exactly one tagged response per command).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// NOTE: do NOT mock.module("server") here. bun's mock.module is global for the
// whole test run, and the "server" barrel re-exports markRead/getDomainUidNext/
// getAccountUidNext — stubbing them on the barrel bleeds into those symbols'
// own dedicated tests (update.test.ts, search.test.ts) and fails them. The
// storeFlagsTyped paths under test never reach those functions (markRead lives
// in the FETCH path), and importing the real barrel is side-effect-free in the
// test env (the pg pool is lazy), so the real module imports cleanly.
import { storeFlagsTyped } from "./message-ops";
import type { Store } from "./store";
import type { StoreRequest } from "./types";
import type { SequenceState } from "./sequence-resolver";

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

// A store whose setFlags resolves to `result` and records its calls.
const makeStore = (result: { uid: number; read?: boolean }[]) => {
  const setFlags = mock(() => Promise.resolve(result));
  return { store: { setFlags } as unknown as Store, setFlags };
};

const uidStoreRequest = (start: number, end?: number): StoreRequest => ({
  sequenceSet: { type: "uid", ranges: [{ start, end }] },
  operation: "+FLAGS",
  flags: ["\\Seen"],
});

// Collects everything written to the IMAP socket.
const makeWriter = () => {
  const lines: string[] = [];
  const write = (data: string) => {
    lines.push(data);
    return true;
  };
  return { write, lines };
};

const taggedResponses = (lines: string[], tag: string) =>
  lines.filter((l) => l.startsWith(`${tag} `));

describe("storeFlagsTyped — empty result (inbox #543)", () => {
  beforeEach(() => {});

  it("sends exactly one tagged response (OK) when no messages match", async () => {
    const { store } = makeStore([]); // setFlags returns no updated mails
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A001",
      uidStoreRequest(999999),
      true,
      store,
      "INBOX",
      false,
      emptySeqState(),
      write
    );

    const tagged = taggedResponses(lines, "A001");
    expect(tagged.length).toBe(1);
    expect(tagged[0]).toBe("A001 OK STORE completed\r\n");
    // The bug emitted two `A001 NO STORE failed` lines.
    expect(lines.some((l) => l.includes("NO STORE failed"))).toBe(false);
  });

  it("emits no untagged FETCH responses for an empty range", async () => {
    const { store } = makeStore([]);
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A002",
      uidStoreRequest(1, 100),
      true,
      store,
      "INBOX",
      false,
      emptySeqState(),
      write
    );

    expect(lines.some((l) => l.startsWith("* "))).toBe(false);
    expect(taggedResponses(lines, "A002")).toEqual([
      "A002 OK STORE completed\r\n",
    ]);
  });

  it("still completes OK and emits FETCH when messages do match", async () => {
    const { store } = makeStore([{ uid: 5, read: true }]);
    const seqState: SequenceState = {
      seqToUid: [5],
      uidToSeq: new Map([[5, 1]]),
    };
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A003",
      uidStoreRequest(5),
      true,
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    expect(lines).toContain("* 1 FETCH (FLAGS (\\Seen))\r\n");
    expect(taggedResponses(lines, "A003")).toEqual([
      "A003 OK STORE completed\r\n",
    ]);
  });

  it("rejects writes on a read-only mailbox with a single NO", async () => {
    const { store, setFlags } = makeStore([]);
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A004",
      uidStoreRequest(1),
      true,
      store,
      "INBOX",
      true, // mailboxReadOnly
      emptySeqState(),
      write
    );

    expect(setFlags).not.toHaveBeenCalled();
    const tagged = taggedResponses(lines, "A004");
    expect(tagged.length).toBe(1);
    expect(tagged[0]).toContain("NO [READ-ONLY]");
  });
});
