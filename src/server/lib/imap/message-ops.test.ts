/**
 * Tests for message-ops.ts — IMAP message operations.
 *
 * Covers three regressions:
 *  - inbox #543: STORE on a UID/sequence range that matches no messages must
 *    send exactly ONE tagged response (OK, not NO). The old code wrote a
 *    tagged NO and threw on an empty result, and the surrounding catch block
 *    then wrote a SECOND tagged NO — two tagged responses for a single
 *    command, which desynchronizes IMAP clients (RFC 3501 §2.2.1 requires
 *    exactly one tagged response per command). [storeFlagsTyped]
 *  - #544: the APPENDUID response code must carry the user's stored
 *    UIDVALIDITY (the same stable value SELECT returns), not a fresh
 *    `Date.now()` timestamp. RFC 4315 requires the APPENDUID's UIDVALIDITY to
 *    match the destination mailbox's UIDVALIDITY so UIDPLUS clients can
 *    correlate the appended message without a full re-sync. [appendMessage]
 *  - #548: an APPEND with no flag list must store the mail with draft = false
 *    (RFC 3501 §6.3.11: absent flag list means "no flags set", not "\Draft
 *    set"). The old `?? true` default misclassified every flag-less APPEND as
 *    a draft, hiding it from the per-account web UI. [appendMessage]
 *
 * Isolation mirrors users.test.ts: mock `pg` so the lazy pool in
 * postgres/client.ts instantiates a FakePool, then run the REAL
 * getDomainUidNext / getAccountUidNext / getImapUidValidity against it.
 * mockQuery is the single seam every DB call funnels through. No DI, and no
 * mock of the `server` barrel (which would bleed across files via Bun's
 * process-global mock.module — see search.test.ts / update.test.ts).
 * `afterAll(restoreLeaves)` + resetPool re-mocks pg back to real.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { MailType } from "common";
import type { Store } from "./store";
import type { StoreRequest, AppendRequest, SearchCriterion } from "./types";
import type { SequenceState } from "./sequence-resolver";

const STORED_UIDVALIDITY = 1716512400;
const DOMAIN_UID = 100;

// pg-FakePool pattern (see users.test.ts): mock `pg` so the lazy pool in
// postgres/client.ts is a FakePool, then run the REAL imap code. The functions
// under test are driven with fake Stores, but appendMessage reaches the `server`
// barrel's getDomainUidNext / getAccountUidNext (which query Postgres), so the
// FakePool keeps those calls off a real connection. We mock `pg` (NOT the
// `server` barrel) so markRead/getDomainUidNext/getAccountUidNext keep their real
// identities — stubbing them on the barrel would bleed into update.test.ts /
// search.test.ts. Importing message-ops AFTER the mock is registered guarantees
// the pool is built from the FakePool.

// A full, schema-valid users row so usersTable.queryOne's `new UserModel(row)`
// validates. imap_uid_validity is pre-set, so getImapUidValidity returns it
// directly without an update.
const USER_ROW = {
  user_id: "user-123",
  username: "admin",
  password: null,
  email: null,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: null,
  imap_uid_validity: STORED_UIDVALIDITY,
};

const mockQuery = mock(async (sql: string) => {
  // getDomainUidNext / getAccountUidNext both SELECT ... AS next_uid FROM mails
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: String(DOMAIN_UID) }], rowCount: 1 };
  }
  // usersTable.queryOne(...) for getImapUidValidity
  return { rows: [USER_ROW], rowCount: 1 };
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

const { appendMessage, storeFlagsTyped, resolveSeqSearchKeys, searchTyped } =
  await import("./message-ops");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

beforeEach(() => {
  mockQuery.mockClear();
});

// ---------------------------------------------------------------------------
// appendMessage — APPENDUID (#544) + flag defaults (#548)
// ---------------------------------------------------------------------------

type FakeStore = {
  getUser: () => { id: string; username: string };
  storeMail: (mail: unknown) => Promise<unknown>;
};

const makeAppendStore = (storeResult: unknown = { _id: "stored" }): FakeStore => ({
  getUser: () => ({ id: "user-123", username: "admin" }),
  storeMail: async () => storeResult,
});

const runAppend = async (
  tag: string,
  store: FakeStore,
  selectedMailbox: string | null = null
) => {
  const writes: string[] = [];
  await appendMessage(
    tag,
    { mailbox: "INBOX", message: "Subject: test\r\n\r\nHello" },
    store as never,
    selectedMailbox,
    (data: string) => {
      writes.push(data);
      return true;
    },
    async () => {}
  );
  return writes.join("");
};

describe("appendMessage — APPENDUID UIDVALIDITY (#544)", () => {
  it("uses the stored UIDVALIDITY, not Date.now(), in the APPENDUID response", async () => {
    const response = await runAppend("A002", makeAppendStore());
    expect(response).toBe(
      `A002 OK [APPENDUID ${STORED_UIDVALIDITY} ${DOMAIN_UID}] APPEND completed\r\n`
    );
  });

  it("does not embed a millisecond wall-clock timestamp as UIDVALIDITY", async () => {
    const response = await runAppend("A003", makeAppendStore());
    const match = response.match(/\[APPENDUID (\d+) /);
    expect(match).not.toBeNull();
    const reported = Number(match![1]);
    // A Date.now() value is a 13-digit ms timestamp (~1.7e12); the stored
    // UIDVALIDITY is the stable, far-smaller seconds value.
    expect(reported).toBe(STORED_UIDVALIDITY);
    expect(reported).toBeLessThan(1e12);
  });

  it("returns NO when the message fails to store (no APPENDUID emitted)", async () => {
    const response = await runAppend("A004", makeAppendStore(null));
    expect(response).toContain("A004 NO APPEND failed to store message");
    expect(response).not.toContain("APPENDUID");
  });
});

// ---------------------------------------------------------------------------
// storeFlagsTyped — empty result (inbox #543)
// ---------------------------------------------------------------------------

// ── Suite 1 helpers ──────────────────────────────────────────────────────────
const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

// A store whose setFlags resolves to `result` and records its calls.
// getUser is included so the #725 pivot-sync path in storeFlagsTyped
// (which reads `store.getUser().id`) doesn't throw when the STORE touches
// `\Flagged` / `\Deleted`.
const makeFlagStore = (
  result: { uid: number; mail_id?: string; read?: boolean; saved?: boolean; deleted?: boolean }[]
) => {
  const setFlags = mock(() => Promise.resolve(result));
  return {
    store: {
      setFlags,
      getUser: () => ({ id: "user-123", username: "admin" }),
    } as unknown as Store,
    setFlags,
  };
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
  it("sends exactly one tagged response (OK) when no messages match", async () => {
    const { store } = makeFlagStore([]); // setFlags returns no updated mails
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
    const { store } = makeFlagStore([]);
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
    const { store } = makeFlagStore([{ uid: 5, read: true }]);
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

    // UID STORE → the untagged FETCH must carry the UID item (#589).
    expect(lines).toContain("* 1 FETCH (UID 5 FLAGS (\\Seen))\r\n");
    expect(taggedResponses(lines, "A003")).toEqual([
      "A003 OK STORE completed\r\n",
    ]);
  });

  it("rejects writes on a read-only mailbox with a single NO", async () => {
    const { store, setFlags } = makeFlagStore([]);
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

// ---------------------------------------------------------------------------
// storeFlagsTyped — UID item on UID-command FETCH (#589, RFC 3501 §6.4.8)
// ---------------------------------------------------------------------------

const seqStoreRequest = (start: number, end?: number): StoreRequest => ({
  sequenceSet: { type: "sequence", ranges: [{ start, end }] },
  operation: "+FLAGS",
  flags: ["\\Seen"],
});

describe("storeFlagsTyped — UID item on UID-command FETCH (#589)", () => {
  const seqState: SequenceState = {
    seqToUid: [11395],
    uidToSeq: new Map([[11395, 1]]),
  };

  it("includes the UID item for a UID STORE", async () => {
    const { store } = makeFlagStore([{ uid: 11395, read: true }]);
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A1",
      uidStoreRequest(11395),
      true, // isUidCommand
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    const fetch = lines.find((l) => l.includes("FETCH"));
    expect(fetch).toBe("* 1 FETCH (UID 11395 FLAGS (\\Seen))\r\n");
  });

  it("omits the UID item for a plain (sequence) STORE", async () => {
    const { store } = makeFlagStore([{ uid: 11395, read: true }]);
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A2",
      seqStoreRequest(1),
      false, // not a UID command
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    const fetch = lines.find((l) => l.includes("FETCH"));
    expect(fetch).toBe("* 1 FETCH (FLAGS (\\Seen))\r\n");
  });

  it("emits no untagged FETCH for a SILENT UID STORE", async () => {
    const { store } = makeFlagStore([{ uid: 11395, read: true }]);
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A3",
      {
        sequenceSet: { type: "uid", ranges: [{ start: 11395 }] },
        operation: "+FLAGS.SILENT",
        flags: ["\\Seen"],
      },
      true,
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    expect(lines.some((l) => l.startsWith("* "))).toBe(false);
    expect(taggedResponses(lines, "A3")).toEqual([
      "A3 OK STORE completed\r\n",
    ]);
  });

  it("emits one FETCH per mail, each carrying its own UID, for a multi-message UID STORE", async () => {
    const { store } = makeFlagStore([
      { uid: 11395, read: true },
      { uid: 11396, read: true },
    ]);
    const multiSeqState: SequenceState = {
      seqToUid: [11395, 11396],
      uidToSeq: new Map([
        [11395, 1],
        [11396, 2],
      ]),
    };
    const { write, lines } = makeWriter();

    await storeFlagsTyped(
      "A4",
      uidStoreRequest(11395, 11396),
      true,
      store,
      "INBOX",
      false,
      multiSeqState,
      write
    );

    const fetches = lines.filter((l) => l.includes("FETCH"));
    expect(fetches).toEqual([
      "* 1 FETCH (UID 11395 FLAGS (\\Seen))\r\n",
      "* 2 FETCH (UID 11396 FLAGS (\\Seen))\r\n",
    ]);
  });
});

// ── Suite 2 helpers ──────────────────────────────────────────────────────────
// Drive appendMessage with a fake store that captures the stored mail.
async function appendAndCapture(flags?: string[]): Promise<MailType> {
  let captured: MailType | undefined;
  const store = {
    getUser: () => ({ id: 1, username: "admin" }),
    storeMail: async (mail: MailType) => {
      captured = mail;
      return true;
    },
  } as unknown as Store;

  const request: AppendRequest = {
    mailbox: "INBOX",
    flags,
    message: "Subject: hello\r\nFrom: a@b.com\r\n\r\nbody",
  } as AppendRequest;

  await appendMessage(
    "a1",
    request,
    store,
    "INBOX",
    () => true,
    async () => {}
  );

  if (!captured) throw new Error("storeMail was never called");
  return captured;
}

describe("appendMessage flag defaults (#548)", () => {
  it("defaults draft to false when no flag list is sent", async () => {
    const mail = await appendAndCapture(undefined);
    expect(mail.draft).toBe(false);
  });

  it("sets draft true only when \\Draft is explicitly present", async () => {
    const mail = await appendAndCapture(["\\Draft"]);
    expect(mail.draft).toBe(true);
  });

  it("leaves the other flags false when absent", async () => {
    const mail = await appendAndCapture(undefined);
    expect(mail.read).toBe(false);
    expect(mail.saved).toBe(false);
    expect(mail.deleted).toBe(false);
    expect(mail.answered).toBe(false);
  });
});

// #649: a bare sequence-set (SEQ) search key names message sequence numbers in
// a plain SEARCH and UIDs in a UID SEARCH. resolveSeqSearchKeys rewrites SEQ to
// a UID criterion so store.search (which has no seqState) can run it, resolving
// against the seq→uid map for a plain SEARCH. A mailbox where seq != uid pins
// the axis: seq 1→uid 11395, seq 2→uid 11396, seq 3→uid 11400 (expunge gap).
describe("resolveSeqSearchKeys — bare sequence-set (#649)", () => {
  const seqState: SequenceState = {
    seqToUid: [11395, 11396, 11400],
    uidToSeq: new Map([
      [11395, 1],
      [11396, 2],
      [11400, 3],
    ]),
  };

  it("plain SEARCH resolves a SEQ range to the matching UID range", () => {
    const out = resolveSeqSearchKeys(
      [{ type: "SEQ", sequenceSet: { type: "sequence", ranges: [{ start: 1, end: 3 }] } }],
      false,
      seqState
    );
    // seq 1:3 → uid 11395:11400 (NOT 1:3 — that would match the wrong axis).
    expect(out).toEqual([
      { type: "UID", sequenceSet: { type: "sequence", ranges: [{ start: 11395, end: 11400 }] } },
    ]);
  });

  it("plain SEARCH resolves a single bare seq number to its UID", () => {
    const out = resolveSeqSearchKeys(
      [{ type: "SEQ", sequenceSet: { type: "sequence", ranges: [{ start: 2 }] } }],
      false,
      seqState
    );
    expect(out).toEqual([
      { type: "UID", sequenceSet: { type: "sequence", ranges: [{ start: 11396, end: 11396 }] } },
    ]);
  });

  it("UID SEARCH keeps the set as UIDs, only relabeling SEQ→UID", () => {
    const set = { type: "sequence" as const, ranges: [{ start: 11395, end: 11400 }] };
    const out = resolveSeqSearchKeys([{ type: "SEQ", sequenceSet: set }], true, seqState);
    expect(out).toEqual([{ type: "UID", sequenceSet: set }]);
  });

  it("a plain-SEARCH SEQ set past the end of the mailbox matches nothing", () => {
    const out = resolveSeqSearchKeys(
      [{ type: "SEQ", sequenceSet: { type: "sequence", ranges: [{ start: 5, end: 7 }] } }],
      false,
      seqState
    );
    // Must NOT vanish from the AND (which would match everything); pin to an
    // impossible UID range so the search returns the empty set.
    expect(out).toEqual([
      { type: "UID", sequenceSet: { type: "sequence", ranges: [{ start: -1, end: -1 }] } },
    ]);
  });

  it("leaves flag criteria untouched; normalizes an explicit UID criterion's ranges", () => {
    const criteria: Parameters<typeof resolveSeqSearchKeys>[0] = [
      { type: "SEEN" },
      { type: "UID", sequenceSet: { type: "sequence", ranges: [{ start: 42 }] } },
    ];
    // The explicit `UID <set>` keyword already names UIDs, but still passes
    // through resolveUidCriterionRanges to normalize `*` (#678) — a
    // single-value range without a `*` comes out with end filled in.
    expect(resolveSeqSearchKeys(criteria, false, seqState)).toEqual([
      { type: "SEEN" },
      { type: "UID", sequenceSet: { type: "sequence", ranges: [{ start: 42, end: 42 }] } },
    ]);
  });

  it("resolves a bare `*` in an explicit UID criterion to the highest UID (#678)", () => {
    const criteria: Parameters<typeof resolveSeqSearchKeys>[0] = [
      {
        type: "UID",
        sequenceSet: { type: "sequence", ranges: [{ start: Number.MAX_SAFE_INTEGER }] },
      },
    ];
    expect(resolveSeqSearchKeys(criteria, false, seqState)).toEqual([
      { type: "UID", sequenceSet: { type: "sequence", ranges: [{ start: 11400, end: 11400 }] } },
    ]);
  });

  it("resolves a SEQ set alongside a flag key (SEEN 1:3)", () => {
    const out = resolveSeqSearchKeys(
      [
        { type: "SEEN" },
        { type: "SEQ", sequenceSet: { type: "sequence", ranges: [{ start: 1, end: 3 }] } },
      ],
      false,
      seqState
    );
    expect(out.map((c) => c.type)).toEqual(["SEEN", "UID"]);
  });

  // reviewoie finding on PR #708: store.simplifyCriterion recurses into
  // NOT/OR operands, so a UID criterion nested under either must have its
  // `*` sentinel resolved here too — otherwise `UID SEARCH NOT UID *` /
  // `UID SEARCH OR UID 1000:* SEEN` still overflow the int4 uid column.
  it("resolves a bare `*` nested under NOT (#678)", () => {
    const criteria: Parameters<typeof resolveSeqSearchKeys>[0] = [
      {
        type: "NOT",
        criterion: {
          type: "UID",
          sequenceSet: { type: "sequence", ranges: [{ start: Number.MAX_SAFE_INTEGER }] },
        },
      },
    ];
    expect(resolveSeqSearchKeys(criteria, false, seqState)).toEqual([
      {
        type: "NOT",
        criterion: {
          type: "UID",
          sequenceSet: { type: "sequence", ranges: [{ start: 11400, end: 11400 }] },
        },
      },
    ]);
  });

  it("resolves a bare `*` nested under OR, on both sides (#678)", () => {
    const criteria: Parameters<typeof resolveSeqSearchKeys>[0] = [
      {
        type: "OR",
        left: {
          type: "UID",
          sequenceSet: { type: "sequence", ranges: [{ start: 1000, end: Number.MAX_SAFE_INTEGER }] },
        },
        right: { type: "SEEN" },
      },
    ];
    expect(resolveSeqSearchKeys(criteria, false, seqState)).toEqual([
      {
        type: "OR",
        left: {
          type: "UID",
          sequenceSet: { type: "sequence", ranges: [{ start: 1000, end: 11400 }] },
        },
        right: { type: "SEEN" },
      },
    ]);
  });
});

// #659: a multi-element bare set (`SEARCH 1,3`) resolves to a multi-range UID
// criterion. store.search once ANDed its ranges (silent empty result), so #658
// gated it with `NO Not supported`. Now the ranges OR among themselves, so the
// set executes on both the plain and UID SEARCH forms — the gate is gone.
describe("searchTyped — multi-element bare set executes (#659)", () => {
  const seqState: SequenceState = {
    seqToUid: [11395, 11396, 11400],
    uidToSeq: new Map([
      [11395, 1],
      [11396, 2],
      [11400, 3],
    ]),
  };
  const seqReq = (ranges: { start: number; end?: number }[]) => ({
    criteria: [{ type: "SEQ" as const, sequenceSet: { type: "sequence" as const, ranges } }],
  });
  const run = async (
    tag: string,
    req: { criteria: unknown[] },
    isUid: boolean
  ): Promise<{ out: string; passed: SearchCriterion[] | null }> => {
    let out = "";
    let passed: SearchCriterion[] | null = null;
    const store = {
      search: async (_box: string, criteria: SearchCriterion[]) => {
        passed = criteria;
        return [];
      },
    } as unknown as Store;
    await searchTyped(
      tag,
      req as Parameters<typeof searchTyped>[1],
      isUid,
      store,
      "INBOX",
      seqState,
      (d: string) => {
        out += d;
        return true;
      }
    );
    return { out, passed };
  };

  it("runs a multi-element plain-SEARCH bare set, resolving both seq→uid ranges", async () => {
    const { out, passed } = await run("t1", seqReq([{ start: 1 }, { start: 3 }]), false);
    expect(out).toContain("OK SEARCH completed");
    expect(out).not.toContain("NO Not supported");
    // seq 1 → uid 11395, seq 3 → uid 11400: both ranges reach store.search.
    expect(passed).toEqual([
      {
        type: "UID",
        sequenceSet: {
          type: "sequence",
          ranges: [
            { start: 11395, end: 11395 },
            { start: 11400, end: 11400 },
          ],
        },
      },
    ]);
  });

  it("runs a single-range plain-SEARCH bare set", async () => {
    const { out } = await run("t2", seqReq([{ start: 1, end: 3 }]), false);
    expect(out).toContain("OK SEARCH completed");
    expect(out).not.toContain("NO Not supported");
  });

  it("runs a multi-element UID-SEARCH bare set, keeping both ranges as UIDs", async () => {
    const { out, passed } = await run("t3", seqReq([{ start: 1 }, { start: 3 }]), true);
    expect(out).toContain("OK SEARCH completed");
    expect(out).not.toContain("NO Not supported");
    // UID SEARCH: the set already names UIDs, so relabel (with `*`
    // normalized, though neither range here uses it — #678).
    expect(passed).toEqual([
      {
        type: "UID",
        sequenceSet: {
          type: "sequence",
          ranges: [
            { start: 1, end: 1 },
            { start: 3, end: 3 },
          ],
        },
      },
    ]);
  });

  it("runs a single-range UID-SEARCH bare set", async () => {
    const { out } = await run("t4", seqReq([{ start: 1, end: 3 }]), true);
    expect(out).toContain("OK SEARCH completed");
    expect(out).not.toContain("NO Not supported");
  });
});

// ---------------------------------------------------------------------------
// storeFlagsTyped — mapped-utility pivot sync (#725)
// ---------------------------------------------------------------------------

describe("storeFlagsTyped — Starred / Trash pivot sync (#725)", () => {
  const seqState: SequenceState = {
    seqToUid: [42],
    uidToSeq: new Map([[42, 1]]),
  };

  const flaggedRequest = (op: "+FLAGS" | "-FLAGS", flag: string): StoreRequest => ({
    sequenceSet: { type: "uid", ranges: [{ start: 42 }] },
    operation: op,
    flags: [flag],
  });

  // Which pool operations fired during the last STORE — pattern-matched off
  // the SQL text mockQuery sees. Deliberately loose: the counters module owns
  // the exact query text; this test only pins WHICH operations happened.
  const seenOps = () => {
    const ops = { pivotInsert: false, pivotDelete: false, counterTick: false };
    for (const call of mockQuery.mock.calls) {
      const sql = String(call[0] ?? "").toLowerCase();
      if (sql.includes("insert into mail_mailbox_uid")) ops.pivotInsert = true;
      if (sql.includes("delete from mail_mailbox_uid")) ops.pivotDelete = true;
      if (sql.includes("mail_uid_counters")) ops.counterTick = true;
    }
    return ops;
  };

  it("inserts a Starred pivot when +FLAGS (\\Flagged) sets saved on a mail", async () => {
    const { store } = makeFlagStore([
      { uid: 42, mail_id: "mail-abc", saved: true, deleted: false },
    ]);
    const { write } = makeWriter();

    await storeFlagsTyped(
      "P1",
      flaggedRequest("+FLAGS", "\\Flagged"),
      true,
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    // The pivot-insert path fired; the pivot-delete did not (this is a set).
    const ops = seenOps();
    expect(ops.pivotInsert).toBe(true);
    expect(ops.pivotDelete).toBe(false);
    expect(ops.counterTick).toBe(true);
  });

  it("deletes the Trash pivot when -FLAGS (\\Deleted) clears deleted on a mail", async () => {
    const { store } = makeFlagStore([
      { uid: 42, mail_id: "mail-abc", saved: false, deleted: false },
    ]);
    const { write } = makeWriter();

    await storeFlagsTyped(
      "P2",
      flaggedRequest("-FLAGS", "\\Deleted"),
      true,
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    // Delete branch, no counter tick (see `syncMailboxPivot`'s delete arm —
    // pinned in counters.test.ts too, asserted here at the wire integration
    // layer to catch a regression in either half without needing both).
    const ops = seenOps();
    expect(ops.pivotDelete).toBe(true);
    expect(ops.pivotInsert).toBe(false);
    expect(ops.counterTick).toBe(false);
  });

  it("does not touch any pivot when +FLAGS (\\Seen) is the only change", async () => {
    // The gate. `touchesSaved` / `touchesDeleted` are false for a Seen-only
    // STORE, so a 100-row bulk `+FLAGS \Seen` skips 200 useless pivot
    // upserts. Pins that skip.
    const { store } = makeFlagStore([
      { uid: 42, mail_id: "mail-abc", read: true, saved: false, deleted: false },
    ]);
    const { write } = makeWriter();

    await storeFlagsTyped(
      "P3",
      flaggedRequest("+FLAGS", "\\Seen"),
      true,
      store,
      "INBOX",
      false,
      seqState,
      write
    );

    const ops = seenOps();
    expect(ops.pivotInsert).toBe(false);
    expect(ops.pivotDelete).toBe(false);
    expect(ops.counterTick).toBe(false);
  });
});
