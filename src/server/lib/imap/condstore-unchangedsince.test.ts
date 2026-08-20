/**
 * Tests for IMAP CONDSTORE phase 4 (RFC 7162 §3.1.3).
 *
 * The conflict-detection layer: `STORE <set> (UNCHANGEDSINCE <n>) <op> <flags>`
 * applies the flag change only to messages whose mod-sequence is ≤ n, and names
 * the rest in a MODIFIED response code. Coverage:
 *  - Parser accepts the modifier between the sequence set and the item name,
 *    rejects an unknown one, and leaves `unchangedSince` undefined when absent.
 *  - The handler puts MODIFIED on the TAGGED response, in UIDs for UID STORE
 *    and sequence numbers for a plain STORE.
 *  - A conditional STORE emits the untagged FETCH even for .SILENT, carrying
 *    MODSEQ, and implicitly enables CONDSTORE for the session.
 *
 * The repository half of the feature — the guarded UPDATE and the
 * matched-minus-updated failed set — is covered next to the repository in
 * postgres/repositories/mails/condstore-unchangedsince.test.ts, with the
 * reason it cannot be exercised behaviourally from this directory.
 *
 * Isolation mirrors condstore.test.ts: mock `pg` so the lazy pool in
 * postgres/client.ts is a FakePool, then run the REAL code. No mock of the
 * `server` barrel — that one bleeds across files via Bun's process-global
 * mock.module.
 */

import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { Store } from "./store";
import type { SequenceState } from "./sequence-resolver";
import type { StoreRequest } from "./types";

// `parseCommand` and `ImapSession` reach postgres/client.ts's lazy pool via the
// module graph, so `pg` is faked to keep it from opening a socket. Nothing here
// asserts on SQL — the repository's behaviour is covered next to the repository
// (see the note below) — so the fake only needs to not blow up.
class FakePool {
  query = mock(async () => ({ rows: [], rowCount: 0 }));
  end = async () => {};
  connect = async () => ({ query: this.query, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const { parseCommand } = await import("./parsers");
const { storeFlagsTyped } = await import("./message-ops");
const { ImapSession } = await import("./session");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const parsedStore = (line: string) => parseCommand(line);

describe("CONDSTORE phase 4 — parsing the UNCHANGEDSINCE modifier", () => {
  it("reads the modifier from between the sequence set and the item name", () => {
    const r = parsedStore("d105 STORE 7,5,9 (UNCHANGEDSINCE 320162338) +FLAGS.SILENT (\\Deleted)");
    expect(r.success).toBe(true);
    expect(r.value!.request.type).toBe("STORE");
    expect(r.value!.request.data.unchangedSince).toBe(320162338);
    // The rest of the command must still parse — the modifier is consumed, not
    // mistaken for the flag list.
    expect(r.value!.request.data.operation).toBe("+FLAGS.SILENT");
    expect(r.value!.request.data.flags).toEqual(["\\Deleted"]);
    expect(r.value!.request.data.sequenceSet.ranges).toEqual([
      { start: 7 },
      { start: 5 },
      { start: 9 },
    ]);
  });

  it("leaves unchangedSince undefined for an ordinary STORE", () => {
    const r = parsedStore("a1 STORE 1:5 +FLAGS (\\Seen)");
    expect(r.success).toBe(true);
    expect(r.value!.request.data.unchangedSince).toBeUndefined();
    expect(r.value!.request.data.flags).toEqual(["\\Seen"]);
  });

  it("accepts UNCHANGEDSINCE 0 — the RFC's always-fails value is a legal parse", () => {
    const r = parsedStore("a1 STORE 1 (UNCHANGEDSINCE 0) +FLAGS (\\Seen)");
    expect(r.success).toBe(true);
    expect(r.value!.request.data.unchangedSince).toBe(0);
  });

  it("is case-insensitive on the modifier name", () => {
    const r = parsedStore("a1 STORE 1 (unchangedsince 42) +FLAGS (\\Seen)");
    expect(r.success).toBe(true);
    expect(r.value!.request.data.unchangedSince).toBe(42);
  });

  it("rejects an unknown modifier rather than silently ignoring it", () => {
    // Dropping it would run an UNCONDITIONAL store where the client asked for a
    // conditional one — the dangerous direction.
    const r = parsedStore("a1 STORE 1 (BOGUSMOD 5) +FLAGS (\\Seen)");
    expect(r.success).toBe(false);
  });

  it("rejects a non-numeric mod-sequence", () => {
    const r = parsedStore("a1 STORE 1 (UNCHANGEDSINCE abc) +FLAGS (\\Seen)");
    expect(r.success).toBe(false);
  });

  it("still parses a UID STORE carrying the modifier", () => {
    const r = parsedStore("a103 UID STORE 6,4,8 (UNCHANGEDSINCE 12121230045) +FLAGS.SILENT (\\Deleted)");
    expect(r.success).toBe(true);
    expect(r.value!.request.type).toBe("UID");
    expect(r.value!.request.data.request.data.unchangedSince).toBe(12121230045);
  });
});

// ---------------------------------------------------------------------------
// Handler — the MODIFIED response code
// ---------------------------------------------------------------------------

const seqStateFor = (uids: number[]): SequenceState => {
  const uidToSeq = new Map<number, number>();
  uids.forEach((uid, i) => uidToSeq.set(uid, i + 1));
  return { seqToUid: uids, uidToSeq };
};

interface FlagResult {
  updated: { uid: number; read: boolean; modseq: number }[];
  failed: number[];
}

// One entry per setFlags call, in order — a sequence set with two ranges
// drives two calls and each has to be able to answer differently, which is
// what the cross-range accumulation depends on. The last entry repeats so a
// single-range case can pass one result.
//
// getUser is included so the mapped-utility pivot sync in storeFlagsTyped
// (which reads `store.getUser().id`) doesn't throw when the STORE touches
// `\Flagged` / `\Deleted`.
const fakeStore = (results: FlagResult[]): Store => {
  let call = 0;
  return {
    setFlags: async () => results[Math.min(call++, results.length - 1)],
    getUser: () => ({ id: "user-123", username: "admin" }),
  } as unknown as Store;
};

const runStore = async (opts: {
  updated?: { uid: number; read: boolean; modseq: number }[];
  failed?: number[];
  /** Per-call results, for a sequence set that drives more than one range. */
  results?: FlagResult[];
  uids?: number[];
  isUidStore?: boolean;
  request?: Partial<StoreRequest>;
  condstoreEnabled?: boolean;
}) => {
  const uids = opts.uids ?? [5, 7, 9];
  const isUidStore = opts.isUidStore ?? true;
  const lines: string[] = [];
  const request: StoreRequest = {
    sequenceSet: isUidStore
      ? { type: "uid", ranges: [{ start: 1, end: 100 }] }
      : { type: "sequence", ranges: [{ start: 1, end: 3 }] },
    operation: "+FLAGS",
    flags: ["\\Deleted"],
    unchangedSince: 320162338,
    ...opts.request,
  };
  await storeFlagsTyped(
    "d105",
    request,
    isUidStore,
    fakeStore(
      opts.results ?? [
        {
          updated: opts.updated ?? [{ uid: 5, read: true, modseq: 320162350 }],
          failed: opts.failed ?? [7, 9],
        },
      ]
    ),
    "INBOX",
    false,
    seqStateFor(uids),
    (data: string) => {
      lines.push(data);
      return true;
    },
    opts.condstoreEnabled ?? false
  );
  return lines;
};

describe("CONDSTORE phase 4 — MODIFIED rides on the tagged response", () => {
  it("names the failed UIDs for a UID STORE and still completes OK", async () => {
    const lines = await runStore({});
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 7,9] Conditional STORE failed\r\n");
    // Not a NO — a lost race is not a command error.
    expect(lines.join("")).not.toContain("NO ");
  });

  it("names failed messages by SEQUENCE NUMBER for a plain STORE", async () => {
    // uids [5,7,9] map to seq 1,2,3 — UIDs 7 and 9 must surface as 2 and 3.
    const lines = await runStore({ isUidStore: false });
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 2:3] Conditional STORE failed\r\n");
  });

  it("compacts the failed set into ranges", async () => {
    const lines = await runStore({
      updated: [{ uid: 1, read: true, modseq: 320162350 }],
      failed: [4, 5, 6, 9],
    });
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 4:6,9] Conditional STORE failed\r\n");
  });

  // RFC 7162 §3.1.3 Example 11 uses `7,3:9` — a sequence set may legally name
  // the same message twice. The first range applies the change to UID 7 and
  // stamps it with this STORE's own mod-sequence, which is above the client's
  // ceiling by construction, so the second range re-matches it and the guarded
  // UPDATE skips it. It must NOT be reported as MODIFIED: the write landed.
  //
  // The two ranges are what makes this real. One `setFlags` call can never
  // return a UID in both halves — `failed` is matched-minus-updated, disjoint
  // from `updated` by construction — so the accumulation being pinned here
  // only exists ACROSS calls.
  const exampleEleven = { ranges: [{ start: 7, end: 7 }, { start: 3, end: 9 }] };

  it("does not report a message that succeeded in an earlier pass over the set", async () => {
    const lines = await runStore({
      request: { sequenceSet: { type: "uid", ...exampleEleven } },
      results: [
        { updated: [{ uid: 7, read: true, modseq: 320162350 }], failed: [] },
        { updated: [], failed: [7] },
      ],
    });
    expect(lines.at(-1)).toBe("d105 OK STORE completed\r\n");
  });

  it("still reports the genuinely-conflicted siblings of a repeated message", async () => {
    const lines = await runStore({
      request: { sequenceSet: { type: "uid", ...exampleEleven } },
      results: [
        { updated: [{ uid: 7, read: true, modseq: 320162350 }], failed: [] },
        { updated: [], failed: [7, 9] },
      ],
    });
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 9] Conditional STORE failed\r\n");
  });

  it("omits MODIFIED entirely when nothing lost the race", async () => {
    const lines = await runStore({ failed: [] });
    expect(lines.at(-1)).toBe("d105 OK STORE completed\r\n");
  });

  it("reports MODIFIED even when every message failed and none was updated", async () => {
    const lines = await runStore({ updated: [], failed: [5, 7, 9] });
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 5,7,9] Conditional STORE failed\r\n");
    expect(lines.filter((l) => l.startsWith("* "))).toEqual([]);
  });

  it("drops a failed UID that has no sequence number in the current view", async () => {
    // Expunged out from under the client — there is no number to report it by,
    // and guessing one would point the client at the wrong message.
    const lines = await runStore({ isUidStore: false, failed: [7, 404] });
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 2] Conditional STORE failed\r\n");
  });
});

describe("CONDSTORE phase 4 — untagged FETCH on a conditional STORE", () => {
  // RFC 7162 §3.1.3: "An untagged FETCH response MUST be sent, even if the
  // .SILENT suffix is specified, and the response MUST include the MODSEQ
  // message data item."
  it("emits MODSEQ for a .SILENT conditional STORE with CONDSTORE never enabled", async () => {
    const lines = await runStore({
      request: { operation: "+FLAGS.SILENT", silent: true },
      condstoreEnabled: false,
    });
    expect(lines.some((l) => l === "* 1 FETCH (UID 5 MODSEQ (320162350))\r\n")).toBe(true);
  });

  it("still suppresses the FLAGS echo for that .SILENT store", async () => {
    const lines = await runStore({
      request: { operation: "+FLAGS.SILENT", silent: true },
      condstoreEnabled: false,
    });
    expect(lines.join("")).not.toContain("FLAGS (\\");
  });

  it("emits FLAGS and MODSEQ together for a non-silent conditional STORE", async () => {
    const lines = await runStore({ condstoreEnabled: false });
    expect(lines.some((l) => l === "* 1 FETCH (UID 5 FLAGS (\\Seen) MODSEQ (320162350))\r\n")).toBe(
      true
    );
  });

  it("stays silent for a .SILENT UNCONDITIONAL store with CONDSTORE off (unchanged behaviour)", async () => {
    const lines = await runStore({
      request: { operation: "+FLAGS.SILENT", silent: true, unchangedSince: undefined },
      failed: [],
      condstoreEnabled: false,
    });
    expect(lines).toEqual(["d105 OK STORE completed\r\n"]);
  });
});

// ---------------------------------------------------------------------------
// Session — UNCHANGEDSINCE implicitly enables CONDSTORE
// ---------------------------------------------------------------------------

const makeSession = () => {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  };
  const session = new ImapSession({ isTls: false } as never, socket as never);
  // Minimum viable authenticated, mailbox-selected session — storeFlagsTyped
  // returns early otherwise and the flag would never be reached.
  (session as unknown as { authenticated: boolean }).authenticated = true;
  (session as unknown as { store: Store }).store = fakeStore([
    { updated: [{ uid: 5, read: true, modseq: 320162350 }], failed: [] },
  ]);
  session.selectedMailbox = "INBOX";
  (session as unknown as { seqState: SequenceState }).seqState = seqStateFor([5]);
  return { session, writes };
};

const silentUnconditional: StoreRequest = {
  sequenceSet: { type: "uid", ranges: [{ start: 5 }] },
  operation: "+FLAGS.SILENT",
  flags: ["\\Seen"],
  silent: true,
};

describe("CONDSTORE phase 4 — UNCHANGEDSINCE implicitly enables CONDSTORE (RFC 7162 §3.1.3)", () => {
  it("a later .SILENT store emits MODSEQ, without the client ever sending ENABLE", async () => {
    const { session, writes } = makeSession();

    // Baseline: with no CONDSTORE, a .SILENT store says nothing.
    await session.storeFlagsTyped("A1", silentUnconditional, true);
    expect(writes.join("")).not.toContain("MODSEQ");

    await session.storeFlagsTyped("A2", { ...silentUnconditional, unchangedSince: 500 }, true);

    writes.length = 0;
    await session.storeFlagsTyped("A3", silentUnconditional, true);
    expect(writes.join("")).toContain("MODSEQ (320162350)");
  });

  it("an unconditional STORE alone does not enable it", async () => {
    const { session, writes } = makeSession();
    await session.storeFlagsTyped("A1", silentUnconditional, true);
    await session.storeFlagsTyped("A2", silentUnconditional, true);
    expect(writes.join("")).not.toContain("MODSEQ");
  });
});
