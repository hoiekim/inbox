/**
 * Tests for IMAP CONDSTORE phase 4 (RFC 7162 §3.1.3) — inbox #610.
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
 * `server` barrel (which would bleed across files via Bun's process-global
 * mock.module).
 */

import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { Store } from "./store";
import type { SequenceState } from "./sequence-resolver";
import type { StoreRequest } from "./types";

const RESERVED_MODSEQ = 900;

// Rows the range matches, with the mod-sequence each currently carries.
let matchedRows: { uid: number; modseq: number }[] = [];
const queries: { sql: string; values: unknown[] }[] = [];

const mockQuery = mock(async (sql: string, values: unknown[] = []) => {
  queries.push({ sql, values });
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: String(RESERVED_MODSEQ) }], rowCount: 1 };
  }
  const row = (r: { uid: number; modseq: number }) => ({
    uid: r.uid,
    read: true,
    saved: false,
    deleted: false,
    draft: false,
    answered: false,
    modseq: r.modseq,
  });
  if (typeof sql === "string" && sql.trimStart().startsWith("SELECT")) {
    return { rows: matchedRows.map(row), rowCount: matchedRows.length };
  }
  // UPDATE: honour the guard the query builder appended, so the failed set is
  // derived the same way Postgres would derive it rather than being asserted
  // into existence.
  const guard = /modseq <= \$(\d+)/.exec(sql);
  const survivors = guard
    ? matchedRows.filter((r) => r.modseq <= Number(values[Number(guard[1]) - 1]))
    : matchedRows;
  return {
    rows: survivors.map((r) => ({ ...row(r), modseq: RESERVED_MODSEQ })),
    rowCount: survivors.length,
  };
});

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
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

beforeEach(() => {
  queries.length = 0;
  matchedRows = [];
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

const fakeStore = (
  updated: { uid: number; read: boolean; modseq: number }[],
  failed: number[]
): Store => ({ setFlags: async () => ({ updated, failed }) }) as unknown as Store;

const runStore = async (opts: {
  updated?: { uid: number; read: boolean; modseq: number }[];
  failed?: number[];
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
    fakeStore(opts.updated ?? [{ uid: 5, read: true, modseq: 320162350 }], opts.failed ?? [7, 9]),
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
    const lines = await runStore({ failed: [4, 5, 6, 9] });
    expect(lines.at(-1)).toBe("d105 OK [MODIFIED 4:6,9] Conditional STORE failed\r\n");
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
  (session as unknown as { store: Store }).store = fakeStore(
    [{ uid: 5, read: true, modseq: 320162350 }],
    []
  );
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
