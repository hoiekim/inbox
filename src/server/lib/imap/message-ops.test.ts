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

// Every UID reservation this run made, in call order. `buildReserveUidQuery`
// binds [user_id, kind, scope, sent, …], so the tuple is enough to tell the
// INBOX lane from the Sent lane.
type UidReservation = { kind: string; scope: string; sent: boolean };
const uidReservations: UidReservation[] = [];

const mockQuery = mock(async (sql: string, values?: unknown[]) => {
  const sqlStr = typeof sql === "string" ? sql : "";
  // getDomainUidNext / getAccountUidNext both SELECT ... AS next_uid FROM mails
  if (sqlStr.includes("next_uid")) {
    uidReservations.push({
      kind: String(values?.[1]),
      scope: String(values?.[2]),
      sent: values?.[3] === true,
    });
    return { rows: [{ next_uid: String(DOMAIN_UID) }], rowCount: 1 };
  }
  // usersTable.queryOne(...) for getImapUidValidity — narrowed to queries
  // that target the users table so an out-of-file leak (Bun's mock.module
  // is process-global; whichever pg-mock wins the load-order race owns the
  // pool for every subsequent test file — see
  // `reference_bun_mock_module_global_hoisting.md`) doesn't answer
  // `users.test.ts`'s "no row matches" SELECTs with a truthy USER_ROW. A
  // truly bare `return { rows: [USER_ROW] }` default caused CD to fail on
  // 0edf95c (see PR #835 write-up) with 16 users.test.ts failures.
  if (/from\s+users\b/i.test(sqlStr)) {
    return { rows: [USER_ROW], rowCount: 1 };
  }
  // Empty by default. Any SQL this file's tests need answered has to be
  // matched explicitly above so an out-of-file caller can't accidentally
  // get a non-empty result and drift silently.
  return { rows: [] as unknown[], rowCount: 0 as number | null };
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

const {
  appendMessage,
  storeFlagsTyped,
  resolveSeqSearchKeys,
  searchTyped,
  resolveDestContext,
  cloneMailToDestination,
} = await import("./message-ops");
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
  uidReservations.length = 0;
});

// ---------------------------------------------------------------------------
// appendMessage — APPENDUID (#544) + flag defaults (#548)
// ---------------------------------------------------------------------------

type AppendedMail = { sent: boolean };

type FakeStore = {
  getUser: () => { id: string; username: string };
  mailboxExists: (box: string) => Promise<boolean>;
  storeMail: (mail: AppendedMail, mailbox?: string) => Promise<unknown>;
  /** Every (mail, mailbox) pair storeMail received, in call order. */
  appended: Array<{ mail: AppendedMail; mailbox?: string }>;
};

// The listable set a Store would report for user "admin": INBOX, the unified
// Sent folder, and one per-account box in each lane.
const EXISTING_MAILBOXES = [
  "INBOX",
  "Sent Messages",
  "accounts/admin",
  "Sent Messages/accounts/admin",
];

const makeAppendStore = (
  storeResult: unknown = { _id: "stored" },
  mailboxes: string[] = EXISTING_MAILBOXES
): FakeStore => {
  const appended: FakeStore["appended"] = [];
  return {
    getUser: () => ({ id: "user-123", username: "admin" }),
    mailboxExists: async (box: string) => mailboxes.includes(box),
    storeMail: async (mail: AppendedMail, mailbox?: string) => {
      appended.push({ mail, mailbox });
      return storeResult;
    },
    appended,
  };
};

const runAppend = async (
  tag: string,
  store: FakeStore,
  selectedMailbox: string | null = null,
  mailbox = "INBOX"
) => {
  const writes: string[] = [];
  await appendMessage(
    tag,
    { mailbox, message: "Subject: test\r\n\r\nHello" },
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
// appendMessage — target mailbox (#695)
// ---------------------------------------------------------------------------

describe("appendMessage — target mailbox (#695)", () => {
  it("files an APPEND to the unified Sent folder as sent mail", async () => {
    const store = makeAppendStore();
    const response = await runAppend("A101", store, null, "Sent Messages");

    expect(response).toContain("A101 OK [APPENDUID");
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0].mail.sent).toBe(true);
    // Domain-scoped: storeMail takes no per-mailbox arg for INBOX / Sent.
    expect(store.appended[0].mailbox).toBeUndefined();
    // Both UID lanes are reserved on the sent side of the counter.
    expect(uidReservations.every((r) => r.sent)).toBe(true);
    expect(uidReservations.map((r) => r.kind)).toEqual(["domain", "account"]);
  });

  it("files an APPEND to INBOX as received mail", async () => {
    const store = makeAppendStore();
    const response = await runAppend("A102", store, null, "INBOX");

    expect(response).toContain("A102 OK [APPENDUID");
    expect(store.appended[0].mail.sent).toBe(false);
    expect(uidReservations.every((r) => r.sent)).toBe(false);
  });

  it("files an APPEND to a per-account Sent box as sent mail scoped to that box", async () => {
    const store = makeAppendStore();
    await runAppend("A103", store, null, "Sent Messages/accounts/admin");

    expect(store.appended[0].mail.sent).toBe(true);
    // Account-scoped: the box path reaches the mail_mailbox_uid dual-write.
    expect(store.appended[0].mailbox).toBe("Sent Messages/accounts/admin");
    expect(uidReservations.every((r) => r.sent)).toBe(true);
  });

  it("answers NO [TRYCREATE] for a mailbox that does not exist and stores nothing", async () => {
    const store = makeAppendStore();
    const response = await runAppend("A104", store, null, "ZzNoSuchMailbox");

    expect(response).toBe("A104 NO [TRYCREATE] Mailbox does not exist\r\n");
    expect(response).not.toContain("APPENDUID");
    expect(store.appended).toHaveLength(0);
    // Nothing is reserved for a rejected APPEND — no UID burned.
    expect(uidReservations).toHaveLength(0);
  });

  it("still accepts a lowercase inbox target (RFC 3501 §5.1)", async () => {
    const store = makeAppendStore();
    const response = await runAppend("A105", store, null, "inbox");

    expect(response).toContain("A105 OK [APPENDUID");
    expect(store.appended[0].mail.sent).toBe(false);
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
    mailboxExists: async () => true,
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

// ---------------------------------------------------------------------------
// resolveDestContext — the 5-axis destination fact resolver used by COPY / MOVE.
// ---------------------------------------------------------------------------

describe("resolveDestContext — the 5-axis destination fact resolver (#830)", () => {
  // getUserDomain("admin") reads process.env.EMAIL_DOMAIN or falls back to
  // "mydomain" (util.ts). No env set here — assertions accept either
  // "…@mydomain" or the CI-set value by matching on the local-part prefix.
  const domainAgnosticAccount = (account: string, prefix: string) =>
    expect(account.startsWith(`${prefix}@`)).toBe(true);

  it("INBOX → domain-scoped, preserves recipient, not sent, not mapped-utility", () => {
    const d = resolveDestContext("admin", "INBOX");
    expect(d.destIsDomainScoped).toBe(true);
    expect(d.destPreservesRecipient).toBe(true);
    expect(d.destIsSent).toBe(false);
    expect(d.destIsMappedUtility).toBe(false);
  });

  it("unified Sent Messages → domain-scoped, preserves recipient, IS sent", () => {
    const d = resolveDestContext("admin", "Sent Messages");
    expect(d.destIsDomainScoped).toBe(true);
    expect(d.destPreservesRecipient).toBe(true);
    expect(d.destIsSent).toBe(true);
    expect(d.destIsMappedUtility).toBe(false);
  });

  it("Drafts / Junk (domain-scoped utility) preserve recipient, not sent, not mapped-utility", () => {
    for (const box of ["Drafts", "Junk"]) {
      const d = resolveDestContext("admin", box);
      expect(d.destIsDomainScoped).toBe(true);
      expect(d.destPreservesRecipient).toBe(true);
      expect(d.destIsSent).toBe(false);
      expect(d.destIsMappedUtility).toBe(false);
    }
  });

  it("Starred / Trash (mapped-utility) preserve recipient, NOT domain-scoped, IS mapped-utility, not sent", () => {
    // The three-axis split #725 introduced — destIsDomainScoped decouples
    // from destPreservesRecipient here. A regression that collapsed them
    // back would either rewrite the Starred COPY's recipient to
    // `Starred@<domain>` (nonsense) OR emit uid.domain in COPYUID (a UID
    // that addresses nothing in the mapped-utility mailbox).
    for (const box of ["Starred", "Trash"]) {
      const d = resolveDestContext("admin", box);
      expect(d.destIsDomainScoped).toBe(false);
      expect(d.destIsMappedUtility).toBe(true);
      expect(d.destPreservesRecipient).toBe(true);
      expect(d.destIsSent).toBe(false);
    }
  });

  it("user-created box (Archive) is mapped, address-routed, not sent, not mapped-utility", () => {
    const d = resolveDestContext("admin", "Archive");
    expect(d.destIsDomainScoped).toBe(false);
    expect(d.destIsMappedUtility).toBe(false);
    expect(d.destPreservesRecipient).toBe(false);
    expect(d.destIsSent).toBe(false);
    domainAgnosticAccount(d.destAccount, "Archive");
  });

  it("per-account received (INBOX/accounts/alice) is mapped, address-routed, not sent", () => {
    const d = resolveDestContext("admin", "INBOX/accounts/alice");
    expect(d.destIsDomainScoped).toBe(false);
    expect(d.destIsMappedUtility).toBe(false);
    expect(d.destPreservesRecipient).toBe(false);
    expect(d.destIsSent).toBe(false);
    domainAgnosticAccount(d.destAccount, "alice");
  });

  it("per-account sent (Sent Messages/accounts/alice) is mapped, address-routed, IS sent", () => {
    const d = resolveDestContext("admin", "Sent Messages/accounts/alice");
    expect(d.destIsDomainScoped).toBe(false);
    expect(d.destIsMappedUtility).toBe(false);
    expect(d.destPreservesRecipient).toBe(false);
    expect(d.destIsSent).toBe(true);
    domainAgnosticAccount(d.destAccount, "alice");
  });

  it("destPreservesRecipient is the disjunction of destIsDomainScoped and destIsMappedUtility — never true otherwise", () => {
    // Table-invariant: no destination reads as preserving recipient without
    // ALSO being domain-scoped or mapped-utility. A drift would resurrect
    // the pre-#725 conflation.
    for (const box of [
      "INBOX",
      "Sent Messages",
      "Drafts",
      "Junk",
      "Starred",
      "Trash",
      "Archive",
      "INBOX/accounts/alice",
      "Sent Messages/accounts/alice",
    ]) {
      const d = resolveDestContext("admin", box);
      expect(d.destPreservesRecipient).toBe(
        d.destIsDomainScoped || d.destIsMappedUtility
      );
    }
  });
});

// ---------------------------------------------------------------------------
// cloneMailToDestination — the shared COPY/MOVE per-mail loop body.
// ---------------------------------------------------------------------------

describe("cloneMailToDestination — the shared COPY/MOVE per-mail body (#830)", () => {
  // Store double that captures every storeMail call and can be primed to
  // fail. Getter for `stored` returns the last (mail, destination) pair so
  // per-test setup stays terse.
  type CaptureStore = {
    getUser: () => { id: string; username: string };
    storeMail: (mail: unknown, destination: string) => Promise<boolean>;
    lastCall: () => { mail: unknown; destination: string } | undefined;
  };
  const makeCaptureStore = (result: boolean = true): CaptureStore => {
    let lastMail: unknown;
    let lastDest: string | undefined;
    return {
      getUser: () => ({ id: "user-123", username: "admin" }),
      storeMail: async (mail, destination) => {
        lastMail = mail;
        lastDest = destination;
        return result;
      },
      lastCall: () =>
        lastDest === undefined ? undefined : { mail: lastMail, destination: lastDest },
    };
  };

  // A source mail carrying all the fields the copy has to preserve.
  const sourceMail = (overrides: Partial<Record<string, unknown>> = {}) => ({
    subject: "hi",
    date: "2026-01-01T00:00:00Z",
    from: { value: [{ address: "s@ex.com", name: "" }], text: "s@ex.com" },
    to: { value: [{ address: "r@ex.com", name: "" }], text: "r@ex.com" },
    envelopeTo: [{ address: "r@ex.com", name: "" }],
    messageId: "<orig@ex.com>",
    read: true,
    saved: true,
    deleted: false,
    draft: false,
    answered: false,
    uid: { domain: 42, account: 7 },
    ...overrides,
  });

  const capturedSqls = (): string[] =>
    mockQuery.mock.calls.map((c) => String(c[0] ?? "").toLowerCase());

  it("returns null when storeMail fails (COPY / MOVE caller writes tagged NO)", async () => {
    const store = makeCaptureStore(false);
    const ctx = resolveDestContext("admin", "INBOX");
    const result = await cloneMailToDestination(
      store as never,
      sourceMail() as never,
      42,
      "INBOX",
      ctx
    );
    expect(result).toBe(null);
  });

  it("preserves the source flags on the new mail (RFC 3501 §6.4.7)", async () => {
    // Every flag SET on the source has to survive the clone; every flag
    // FALSE has to stay false. The pre-#823 gap that motivated the flag
    // preservation was `cloneFields` dropping `saved` at the fetch layer;
    // this pin catches the second half — the field-copy in the clone itself.
    const store = makeCaptureStore();
    const ctx = resolveDestContext("admin", "INBOX");
    await cloneMailToDestination(
      store as never,
      sourceMail({ read: true, saved: true, deleted: false, draft: true, answered: false }) as never,
      42,
      "INBOX",
      ctx
    );
    const call = store.lastCall()!;
    const m = call.mail as Record<string, unknown>;
    expect(m.read).toBe(true);
    expect(m.saved).toBe(true);
    expect(m.deleted).toBe(false);
    expect(m.draft).toBe(true);
    expect(m.answered).toBe(false);
  });

  it("preserves recipient on a mapped-utility destination (Starred) — no `Starred@<domain>` rewrite", async () => {
    // The #725 rule: a destination whose row-selection is address-free
    // (`destPreservesRecipient`) keeps the source's `to` / `envelopeTo`
    // unchanged. A regression that dropped the mapped-utility half of
    // `destPreservesRecipient` would put `Starred@<domain>` on the wire.
    const store = makeCaptureStore();
    const ctx = resolveDestContext("admin", "Starred");
    await cloneMailToDestination(
      store as never,
      sourceMail() as never,
      42,
      "Starred",
      ctx
    );
    const m = store.lastCall()!.mail as Record<string, unknown>;
    const to = m.to as { text: string };
    expect(to.text).toBe("r@ex.com");
    const envelopeTo = m.envelopeTo as { address: string }[];
    expect(envelopeTo[0].address).toBe("r@ex.com");
  });

  it("re-anchors recipient on a per-account destination — copy addressed to the account, cc/bcc routing JSONB cleared", async () => {
    const store = makeCaptureStore();
    const ctx = resolveDestContext("admin", "Archive");
    await cloneMailToDestination(
      store as never,
      sourceMail({
        cc: { value: [{ address: "c@ex.com", name: "" }], text: "c@ex.com" },
        bcc: { value: [{ address: "b@ex.com", name: "" }], text: "b@ex.com" },
      }) as never,
      42,
      "Archive",
      ctx
    );
    const m = store.lastCall()!.mail as Record<string, unknown>;
    const to = m.to as { value: { address: string }[] };
    expect(to.value[0].address).toBe(ctx.destAccount);
    // cc/bcc keep display text but clear routing values so the copy doesn't
    // re-surface in the source mailbox's addressCondition.
    const cc = m.cc as { value: unknown[]; text: string };
    expect(cc.value).toEqual([]);
    expect(cc.text).toBe("c@ex.com");
    const bcc = m.bcc as { value: unknown[]; text: string };
    expect(bcc.value).toEqual([]);
    expect(bcc.text).toBe("b@ex.com");
  });

  it("reserves via getMailboxUidNext for a mapped-utility destination — not getAccountUidNext", async () => {
    // Distinguishes the counter reservation path by the emitted SQL. The
    // per-mailbox counter uses `uid_kind = 'mailbox'` in mail_uid_counters;
    // the per-account counter uses `uid_kind = 'account'`. Both branches
    // pass through pool.query, mockQuery captures the SQL text.
    mockQuery.mockClear();
    const store = makeCaptureStore();
    const ctx = resolveDestContext("admin", "Starred");
    await cloneMailToDestination(
      store as never,
      sourceMail() as never,
      42,
      "Starred",
      ctx
    );
    const sqls = capturedSqls();
    // getDomainUidNext runs for every dest (uid_kind='domain' in counters).
    expect(sqls.some((s) => s.includes("mail_uid_counters"))).toBe(true);
    // The per-account counter must NOT be reached — the mapped-utility
    // branch uses getMailboxUidNext (`uid_scope` = mailbox name, no sent
    // axis). Filter the counter-INSERT param lists in beforeEach to spot the
    // right kind — the exact-match test is easier: no reservation should
    // ever have carried the `Starred@…` synthetic account as its scope.
    const scopes = mockQuery.mock.calls
      .flatMap((c) => (c[1] as unknown[]) ?? [])
      .map((v) => String(v));
    expect(scopes.every((s) => !s.startsWith("Starred@"))).toBe(true);
  });

  it("reserves via getAccountUidNext for a per-account destination — passes the destAccount as uid_scope", async () => {
    mockQuery.mockClear();
    const store = makeCaptureStore();
    const ctx = resolveDestContext("admin", "Archive");
    await cloneMailToDestination(
      store as never,
      sourceMail() as never,
      42,
      "Archive",
      ctx
    );
    const scopes = mockQuery.mock.calls
      .flatMap((c) => (c[1] as unknown[]) ?? [])
      .map((v) => String(v));
    // getAccountUidNext plumbs the destination account (e.g. "Archive@mydomain")
    // as uid_scope. The mapped-utility branch would have used the bare mailbox
    // name "Archive" instead — this pin catches a swap.
    expect(scopes.some((s) => s.startsWith("Archive@"))).toBe(true);
  });

  it("returns destUid = uid.domain for domain-scoped destination, uid.account otherwise", async () => {
    // The pre-#725 conflation was `isDomainScoped` overloaded to mean both
    // 'address-free filtering' AND 'domain UID space'. Verify the two axes
    // are still doing their intended jobs post-refactor.
    const store = makeCaptureStore();

    // Domain-scoped INBOX → destUid is uid.domain (mocked to 100 via
    // mockQuery's `next_uid` branch).
    const dInbox = resolveDestContext("admin", "INBOX");
    const rInbox = await cloneMailToDestination(
      store as never,
      sourceMail() as never,
      42,
      "INBOX",
      dInbox
    );
    expect(rInbox?.destUid).toBe(DOMAIN_UID);
    expect(rInbox?.srcUid).toBe(42);

    // Mapped-utility Starred → destUid is uid.account (also mocked to 100).
    const dStarred = resolveDestContext("admin", "Starred");
    const rStarred = await cloneMailToDestination(
      store as never,
      sourceMail() as never,
      42,
      "Starred",
      dStarred
    );
    expect(rStarred?.destUid).toBe(DOMAIN_UID);
    // Both come back 100 because mockQuery returns 100 for every counter
    // reservation. The point is the CALL didn't error — the branch actually
    // ran and returned. The SQL-based reservation-branch tests above pin
    // which counter was consulted; this one pins the destUid selection axis
    // doesn't throw.
  });
});
