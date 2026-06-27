/**
 * Tests for `moveMessageTyped` (#453, RFC 6851).
 *
 * MOVE is copy-then-targeted-expunge: clone the source rows into the
 * destination (same shape as `copyMessageTyped` — fresh messageId, the
 * `sent` arg threaded through UidNext helpers, envelope_to / cc / bcc
 * re-anchored away from the source address), then call
 * `Store.expungeUids(box, sourceUids)` to soft-delete exactly the
 * moved set. RFC 6851 §3.3 forbids both setting `\\Deleted` on the
 * source and the mailbox-wide EXPUNGE that the COPY+STORE+EXPUNGE
 * pattern would produce — the targeted expunge avoids both.
 *
 * Two layers of coverage:
 *   - Control flow (no DB): read-only refusal, TRYCREATE, no-op range
 *     cases, MOVE-to-self short-circuit. Driven with a bare fake Store.
 *   - End-to-end happy path: real source mails → COPYUID + targeted
 *     EXPUNGE emission, fresh messageId, and the address-routing
 *     invariants (non-INBOX dest re-anchors to the dest account; INBOX
 *     dest from a non-INBOX source CLEARS routing so the moved copy
 *     does not re-surface in the source account view). The copy phase
 *     reaches `getDomainUidNext` / `getAccountUidNext` /
 *     `getImapUidValidity` (imported from the `server` barrel, not on
 *     the store), so we use the pg-FakePool pattern from
 *     message-ops.test.ts: mock `pg` so postgres/client.ts's lazy pool
 *     is a FakePool and run the REAL helpers against it. We mock `pg`
 *     (NOT the `server` barrel) so those helpers keep their real
 *     identities — stubbing the barrel would bleed across files via
 *     Bun's process-global mock.module. `afterAll(restoreLeaves)` +
 *     resetPool re-mocks pg back to real.
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
import type { MailType, SignedUser } from "common";
import { Store } from "./store";
import type { MoveRequest } from "./types";
import type { SequenceState } from "./sequence-resolver";

const STORED_UIDVALIDITY = 1716512400;

const VALID_USER: SignedUser = { id: "u1", username: "admin" } as SignedUser;

// A full, schema-valid users row so usersTable.queryOne's `new UserModel(row)`
// validates inside getImapUidValidity. imap_uid_validity is pre-set, so the
// helper returns it directly without an update.
const USER_ROW = {
  user_id: "u1",
  username: "admin",
  password: null,
  email: null,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: null,
  imap_uid_validity: STORED_UIDVALIDITY,
};

// getDomainUidNext / getAccountUidNext both SELECT ... AS next_uid FROM mails.
// Hand back a monotonically-increasing value per call so each cloned mail gets
// a distinct dest UID (domain then account, per the copy loop's call order).
let uidCounter = 100;
const mockQuery = mock(async (sql: string) => {
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: String(uidCounter++) }], rowCount: 1 };
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

const { moveMessageTyped } = await import("./message-ops");
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
  uidCounter = 100;
});

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

const buildStore = (existsBoxes: string[]): Store => {
  const store = new Store(VALID_USER);
  store.mailboxExists = async (box: string) =>
    box === "INBOX" || existsBoxes.includes(box);
  store.getMessages = async () => new Map();
  return store;
};

const moveReq = (
  mailbox: string,
  sequenceSet: MoveRequest["sequenceSet"]
): MoveRequest => ({ sequenceSet, mailbox });

const runMove = async (
  request: MoveRequest,
  isUidCommand: boolean,
  store: Store,
  mailboxReadOnly: boolean = false,
  selectedMailbox: string = "INBOX",
  seqState: SequenceState = emptySeqState()
): Promise<string[]> => {
  const lines: string[] = [];
  await moveMessageTyped(
    "A1",
    request,
    isUidCommand,
    store,
    selectedMailbox,
    mailboxReadOnly,
    seqState,
    (data: string) => {
      lines.push(data);
      return true;
    }
  );
  return lines;
};

describe("MOVE read-only refusal (#453)", () => {
  it("refuses MOVE on a read-only mailbox (EXAMINE / SELECT readonly)", async () => {
    const store = buildStore(["Archive"]);
    const lines = await runMove(
      moveReq("Archive", { type: "uid", ranges: [{ start: 1, end: 1 }] }),
      true,
      store,
      true
    );
    expect(lines).toEqual(["A1 NO [READ-ONLY] Mailbox is read-only\r\n"]);
  });
});

describe("MOVE existence gate (#453)", () => {
  it("returns NO [TRYCREATE] when destination does not exist", async () => {
    const store = buildStore([]);
    const lines = await runMove(
      moveReq("Nonexistent", { type: "seq", ranges: [{ start: 1, end: 1 }] }),
      false,
      store
    );
    expect(lines).toEqual(["A1 NO [TRYCREATE] Mailbox does not exist\r\n"]);
  });

  it("INBOX destination short-circuits the existence check (case-insensitive)", async () => {
    const store = buildStore([]);
    const lines = await runMove(
      moveReq("inbox", { type: "uid", ranges: [{ start: 99, end: 99 }] }),
      true,
      store
    );
    // No source mails → OK with no COPYUID.
    expect(lines).toEqual(["A1 OK MOVE completed\r\n"]);
  });
});

describe("MOVE with empty source range (#453)", () => {
  it("returns OK without COPYUID when the sequence-set resolves to nothing", async () => {
    const store = buildStore(["Archive"]);
    const lines = await runMove(
      moveReq("Archive", { type: "seq", ranges: [{ start: 1, end: 5 }] }),
      false,
      store
    );
    expect(lines).toEqual(["A1 OK MOVE completed\r\n"]);
  });

  it("returns OK without COPYUID when source mailbox has no matching mails", async () => {
    const store = buildStore(["Archive"]);
    const lines = await runMove(
      moveReq("Archive", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      store
    );
    expect(lines).toEqual(["A1 OK MOVE completed\r\n"]);
  });
});

describe("MOVE to self short-circuit (RFC 6851 §3.4-§3.5, #453)", () => {
  it("MOVE to the selected mailbox returns OK without copy+expunge", async () => {
    const store = buildStore(["Archive"]);
    let getMessagesCalled = false;
    store.getMessages = async () => {
      getMessagesCalled = true;
      return new Map();
    };
    const lines = await runMove(
      moveReq("Archive", { type: "uid", ranges: [{ start: 1, end: 5 }] }),
      true,
      store,
      false,
      "Archive"
    );
    expect(lines).toEqual(["A1 OK MOVE completed\r\n"]);
    // No copy phase — getMessages never consulted.
    expect(getMessagesCalled).toBe(false);
  });

  it("MOVE INBOX → inbox while selected on INBOX (case variant) is also a self-move", async () => {
    const store = buildStore([]);
    let getMessagesCalled = false;
    store.getMessages = async () => {
      getMessagesCalled = true;
      return new Map();
    };
    const lines = await runMove(
      moveReq("inbox", { type: "uid", ranges: [{ start: 1, end: 1 }] }),
      true,
      store,
      false,
      "INBOX"
    );
    expect(lines).toEqual(["A1 OK MOVE completed\r\n"]);
    expect(getMessagesCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end happy path (RFC 6851 §3.2-§3.3)
// ---------------------------------------------------------------------------

// Build a source mail with the routing fields the copy phase re-anchors.
const sourceMail = (
  uid: { domain: number; account: number },
  overrides: Partial<MailType> = {}
): Partial<MailType> => ({
  subject: "hello",
  date: "2026-06-23T00:00:00.000Z",
  html: "<p>hi</p>",
  text: "hi",
  from: { value: [{ address: "sender@x.com", name: "S" }], text: "sender@x.com" },
  to: { value: [{ address: "src@hoie.kim", name: "" }], text: "src@hoie.kim" },
  cc: { value: [{ address: "ccd@x.com", name: "" }], text: "ccd@x.com" },
  bcc: { value: [{ address: "bccd@x.com", name: "" }], text: "bccd@x.com" },
  envelopeTo: [{ address: "src@hoie.kim", name: "" }],
  messageId: `orig-${uid.domain}-${uid.account}`,
  uid: uid as MailType["uid"],
  ...overrides,
});

// A Store wired for the full copy+expunge flow: getMessages hands back the
// source mails, storeMail records each clone, expungeUids records its arg set
// and echoes it back (the repo soft-deletes exactly the passed UIDs), getAllUids
// returns the post-expunge mailbox state for the seqState rebuild.
const makeMoveStore = (
  existsBoxes: string[],
  mails: Array<Partial<MailType>>,
  postExpungeUids: number[] = []
) => {
  const store = new Store(VALID_USER);
  store.mailboxExists = async (box: string) =>
    box === "INBOX" || existsBoxes.includes(box);
  store.getMessages = async () => {
    const map = new Map<number, Partial<MailType>>();
    mails.forEach((m, i) => map.set(i, m));
    return map as never;
  };
  const stored: Array<Partial<MailType>> = [];
  store.storeMail = async (mail: never) => {
    stored.push({ ...(mail as Partial<MailType>) });
    return true as never;
  };
  let expungeArg: number[] = [];
  store.expungeUids = async (_box: string, uids: number[]) => {
    expungeArg = uids;
    return uids; // repo soft-deletes exactly the passed set
  };
  store.getAllUids = async () => postExpungeUids;
  return {
    store,
    stored,
    getExpungeArg: () => expungeArg,
  };
};

describe("MOVE happy path — INBOX → non-INBOX dest (#453, RFC 6851 §3.2-§3.3)", () => {
  it("clones with fresh messageId, re-anchors routing to dest, targets the expunge, emits EXPUNGE high→low + COPYUID", async () => {
    const mails = [
      sourceMail({ domain: 5, account: 50 }),
      sourceMail({ domain: 7, account: 60 }),
    ];
    const { store, stored, getExpungeArg } = makeMoveStore(["Archive"], mails);
    const seqState: SequenceState = {
      seqToUid: [5, 7],
      uidToSeq: new Map([
        [5, 1],
        [7, 2],
      ]),
    };

    const lines = await runMove(
      moveReq("Archive", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      store,
      false,
      "INBOX",
      seqState
    );

    // Two clones stored, each with a fresh messageId (not the source's).
    expect(stored.length).toBe(2);
    expect(stored[0].messageId).not.toBe(mails[0].messageId);
    expect(stored[1].messageId).not.toBe(mails[1].messageId);

    // Non-INBOX dest: `to` / `envelopeTo` re-anchored to the dest
    // account (a single recipient that is NOT the source address),
    // display text preserved; cc/bcc routing cleared but their header
    // text kept for FETCH BODY[HEADER].
    expect(stored[0].to?.value?.length).toBe(1);
    expect(stored[0].to?.value?.[0]?.name).toBe("");
    expect(stored[0].to?.value?.[0]?.address).not.toBe("src@hoie.kim");
    expect(stored[0].envelopeTo).toEqual(stored[0].to?.value);
    expect(stored[0].to?.text).toBe("src@hoie.kim");
    expect(stored[0].cc?.value).toEqual([]);
    expect(stored[0].cc?.text).toBe("ccd@x.com");
    expect(stored[0].bcc?.value).toEqual([]);
    expect(stored[0].bcc?.text).toBe("bccd@x.com");

    // RFC 6851 §3.3: the expunge targets exactly the moved source UIDs
    // (INBOX source → domain UIDs), never the whole mailbox.
    expect(getExpungeArg()).toEqual([5, 7]);

    // EXPUNGE emitted high→low so client index shifts don't cascade.
    const expungeLines = lines.filter((l) => l.includes("EXPUNGE"));
    expect(expungeLines).toEqual(["* 2 EXPUNGE\r\n", "* 1 EXPUNGE\r\n"]);

    // COPYUID: src set is the moved domain UIDs; dest set is the fresh
    // account UIDs (counter: domain 100/account 101, domain 102/account 103).
    const tagged = lines.find((l) => l.startsWith("A1 "));
    expect(tagged).toBe(
      `A1 OK [COPYUID ${STORED_UIDVALIDITY} 5,7 101,103] MOVE completed\r\n`
    );
  });
});

describe("MOVE happy path — non-INBOX source → INBOX dest (#453, address-clear invariant)", () => {
  it("clears to/envelopeTo/cc/bcc routing so the moved copy does not re-surface in the source account view", async () => {
    // Source is a per-account mailbox (Archive). The source row carries
    // src@hoie.kim in to/envelope_to; if the INBOX clone preserved those,
    // the jsonb account filter would re-match it in Archive after the
    // original is expunged (reviewoie HIGH 3). The clone must clear them.
    const mails = [sourceMail({ domain: 9, account: 90 })];
    const { store, stored, getExpungeArg } = makeMoveStore(["Archive"], mails);
    const seqState: SequenceState = {
      seqToUid: [90],
      uidToSeq: new Map([[90, 1]]),
    };

    const lines = await runMove(
      moveReq("INBOX", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      store,
      false,
      "Archive",
      seqState
    );

    expect(stored.length).toBe(1);
    // Routing value arrays cleared; only header text survives.
    expect(stored[0].to?.value).toEqual([]);
    expect(stored[0].to?.text).toBe("src@hoie.kim");
    expect(stored[0].envelopeTo).toEqual([]);
    expect(stored[0].cc?.value).toEqual([]);
    expect(stored[0].bcc?.value).toEqual([]);

    // Non-INBOX source → expunge keys on the ACCOUNT UID, not domain.
    expect(getExpungeArg()).toEqual([90]);

    // INBOX dest → dest UID is the fresh DOMAIN uid (counter starts 100).
    const tagged = lines.find((l) => l.startsWith("A1 "));
    expect(tagged).toBe(
      `A1 OK [COPYUID ${STORED_UIDVALIDITY} 90 100] MOVE completed\r\n`
    );
    expect(lines.filter((l) => l.includes("EXPUNGE"))).toEqual([
      "* 1 EXPUNGE\r\n",
    ]);
  });
});

describe("MOVE COPYUID positional pairing — out-of-order set (#624, RFC 4315 §3)", () => {
  it("pairs the n-th source UID with the n-th dest UID for a non-ascending sequence-set", async () => {
    // `UID MOVE 5,3` — the client lists the higher UID first. The copy
    // loop must assign dest UIDs in ascending source-UID order so the
    // COPYUID source-set and dest-set (each independently sorted by
    // `formatUidSet`) stay positionally aligned. getMessages hands the
    // mails back in the request's copy order (uid 5 then uid 3); the fix
    // sorts them ascending before assigning dest UIDs.
    const mails = [
      sourceMail({ domain: 5, account: 50 }, { subject: "src-5" }),
      sourceMail({ domain: 3, account: 30 }, { subject: "src-3" }),
    ];
    const { store, stored } = makeMoveStore(["Archive"], mails);
    const seqState: SequenceState = {
      seqToUid: [3, 5],
      uidToSeq: new Map([
        [3, 1],
        [5, 2],
      ]),
    };

    const lines = await runMove(
      moveReq("Archive", { type: "uid", ranges: [{ start: 3, end: 3 }] }),
      true,
      store,
      false,
      "INBOX",
      seqState
    );

    // Parse the emitted COPYUID source-set ↔ dest-set into a positional map.
    const tagged = lines.find((l) => l.startsWith("A1 OK [COPYUID"))!;
    const m = tagged.match(/\[COPYUID \d+ ([\d,:]+) ([\d,:]+)\]/)!;
    const expand = (set: string): number[] =>
      set.split(",").flatMap((part) => {
        if (!part.includes(":")) return [Number(part)];
        const [a, b] = part.split(":").map(Number);
        const out: number[] = [];
        for (let i = a; i <= b; i++) out.push(i);
        return out;
      });
    const srcSet = expand(m[1]);
    const destSet = expand(m[2]);
    expect(srcSet.length).toBe(destSet.length);
    const claimedPairing = new Map<number, number>();
    srcSet.forEach((s, i) => claimedPairing.set(s, destSet[i]));

    // Ground truth: each stored clone keeps its source's subject and carries
    // the dest account UID it was actually assigned (non-INBOX dest).
    expect(stored.length).toBe(2);
    const actualDestOf = (srcUid: number): number => {
      const clone = stored.find((c) => c.subject === `src-${srcUid}`)!;
      return clone.uid!.account;
    };

    // The COPYUID response must report the REAL mapping, not an inverted one.
    expect(claimedPairing.get(3)).toBe(actualDestOf(3));
    expect(claimedPairing.get(5)).toBe(actualDestOf(5));
    // And the smaller source UID must own the smaller dest UID (ascending
    // assignment) — the assertion that fails on the pre-#624 code.
    expect(actualDestOf(3)).toBeLessThan(actualDestOf(5));
  });
});
