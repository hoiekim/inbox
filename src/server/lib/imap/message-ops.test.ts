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
import type { StoreRequest, AppendRequest } from "./types";
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

const { appendMessage, storeFlagsTyped } = await import("./message-ops");
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
const makeFlagStore = (result: { uid: number; read?: boolean }[]) => {
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
