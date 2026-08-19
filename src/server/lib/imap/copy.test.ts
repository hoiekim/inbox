
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
import { boxToAccount } from "./util";
import type { CopyRequest } from "./types";
import type { SequenceState } from "./sequence-resolver";

const VALID_USER: SignedUser = { id: "u1", username: "admin" } as SignedUser;

const STORED_UIDVALIDITY = 1716512400;

// A schema-valid users row so usersTable.queryOne's `new UserModel(row)`
// validates inside getImapUidValidity (imap_uid_validity pre-set → returned
// directly). Mirrors the move.test.ts / message-ops.test.ts FakePool fixture.
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

// getDomainUidNext / getAccountUidNext both SELECT ... AS next_uid. Hand back a
// monotonically-increasing value per call so each cloned mail gets a distinct
// dest UID in the copy loop's call order (domain then account).
let uidCounter = 100;
const mockQuery = mock(async (sql: string) => {
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: String(uidCounter++) }], rowCount: 1 };
  }
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

// Mock `pg` (NOT the `server` barrel) so the real getDomainUidNext /
// getAccountUidNext / getImapUidValidity run against the FakePool and keep
// their real identities — stubbing the barrel would bleed across files via
// Bun's process-global mock.module. The control-flow tests below never reach
// the per-mail loop, so the mocked pool is harmless to them; the happy-path
// tests exercise it. `afterAll(restoreLeaves)` + resetPool re-mocks pg to real.
mock.module("pg", pgMock);

const { copyMessageTyped } = await import("./message-ops");
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

/**
 * A Store with every method that `copyMessageTyped` might call,
 * patchable per-test. `storeMail` records its calls so the test can assert
 * what was actually written.
 */
interface FakeStoreContext {
  store: Store;
  storeMailCalls: Array<Partial<MailType>>;
}

const buildStore = (opts: {
  existsBoxes: string[];
  sourceMails?: Array<Partial<MailType>>;
  storeMailReturns?: boolean;
}): FakeStoreContext => {
  const store = new Store(VALID_USER);
  const storeMailCalls: Array<Partial<MailType>> = [];
  store.mailboxExists = async (box: string) =>
    box === "INBOX" || opts.existsBoxes.includes(box);
  store.getMessages = async () => {
    const result = new Map<string, Partial<MailType>>();
    (opts.sourceMails || []).forEach((mail, i) =>
      result.set(`id-${i}`, mail)
    );
    return result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).storeMail = async (mail: any) => {
    storeMailCalls.push({ ...mail });
    return opts.storeMailReturns ?? true;
  };
  return { store, storeMailCalls };
};

const copyReq = (
  mailbox: string,
  sequenceSet: CopyRequest["sequenceSet"]
): CopyRequest => ({ sequenceSet, mailbox });

const runCopy = async (
  copyRequest: CopyRequest,
  isUidCommand: boolean,
  ctx: FakeStoreContext,
  selectedMailbox: string = "INBOX",
  seqState: SequenceState = emptySeqState()
): Promise<string[]> => {
  const lines: string[] = [];
  await copyMessageTyped(
    "A1",
    copyRequest,
    isUidCommand,
    ctx.store,
    selectedMailbox,
    seqState,
    (data: string) => {
      lines.push(data);
      return true;
    }
  );
  return lines;
};

describe("COPY existence gate (#520)", () => {
  it("returns NO [TRYCREATE] when destination mailbox does not exist", async () => {
    const ctx = buildStore({ existsBoxes: [] });
    const lines = await runCopy(
      copyReq("Nonexistent", {
        type: "seq",
        ranges: [{ start: 1, end: 1 }],
      }),
      false,
      ctx
    );
    expect(lines).toEqual([
      "A1 NO [TRYCREATE] Mailbox does not exist\r\n",
    ]);
    expect(ctx.storeMailCalls).toEqual([]);
  });

  it("INBOX as destination short-circuits the existence check (case-insensitive)", async () => {
    // `mailboxExists` returns true for INBOX without consulting the list.
    // Test that an "inbox"-cased destination is accepted by the same path.
    const ctx = buildStore({ existsBoxes: [] });
    const lines = await runCopy(
      copyReq("inbox", {
        type: "uid",
        ranges: [{ start: 99, end: 99 }],
      }),
      true,
      ctx
    );
    // No source mails (getMessages returns empty) — OK with no COPYUID.
    expect(lines).toEqual(["A1 OK COPY completed\r\n"]);
    expect(ctx.storeMailCalls).toEqual([]);
  });
});

describe("COPY with empty source range (#520)", () => {
  it("returns OK without COPYUID when the sequence-set resolves to nothing", async () => {
    const ctx = buildStore({ existsBoxes: ["Archive"] });
    // seqState empty → resolveSeqRangeToUids returns null for any range
    const lines = await runCopy(
      copyReq("Archive", {
        type: "seq",
        ranges: [{ start: 1, end: 5 }],
      }),
      false,
      ctx
    );
    expect(lines).toEqual(["A1 OK COPY completed\r\n"]);
    expect(ctx.storeMailCalls).toEqual([]);
  });

  it("returns OK without COPYUID when the source mailbox has no matching mails", async () => {
    // Source range valid but getMessages returns empty.
    const ctx = buildStore({ existsBoxes: ["Archive"], sourceMails: [] });
    const lines = await runCopy(
      copyReq("Archive", {
        type: "uid",
        ranges: [{ start: 1, end: 100 }],
      }),
      true,
      ctx
    );
    expect(lines).toEqual(["A1 OK COPY completed\r\n"]);
    expect(ctx.storeMailCalls).toEqual([]);
  });
});

// Build a source mail carrying a distinguishing subject + UID so the COPYUID
// pairing can be cross-checked against the stored clone.
const sourceMail = (
  uid: { domain: number; account: number },
  overrides: Partial<MailType> = {}
): Partial<MailType> => ({
  subject: `src-${uid.domain}`,
  date: "2026-06-27T00:00:00.000Z",
  html: "<p>hi</p>",
  text: "hi",
  from: { value: [{ address: "sender@x.com", name: "S" }], text: "sender@x.com" },
  to: { value: [{ address: "src@hoie.kim", name: "" }], text: "src@hoie.kim" },
  envelopeTo: [{ address: "src@hoie.kim", name: "" }],
  messageId: `orig-${uid.domain}-${uid.account}`,
  uid: uid as MailType["uid"],
  ...overrides,
});

// A Store wired for the full copy flow: getMessages hands back the source
// mails in the supplied (copy) order; storeMail records each clone (so the
// test can read the dest UID actually assigned to each source).
const makeCopyStore = (
  existsBoxes: string[],
  mails: Array<Partial<MailType>>
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
  return { store, stored };
};

describe("COPY happy path (#520)", () => {
  it("copies source mails to a non-INBOX dest with fresh UIDs and emits COPYUID", async () => {
    const mails = [
      sourceMail({ domain: 5, account: 50 }),
      sourceMail({ domain: 7, account: 70 }),
    ];
    const { store, stored } = makeCopyStore(["Archive"], mails);
    const lines = await runCopy(
      copyReq("Archive", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      { store, storeMailCalls: stored }
    );
    expect(stored.length).toBe(2);
    // Fresh messageId on each clone.
    expect(stored[0].messageId).not.toBe(mails[0].messageId);
    // Non-INBOX dest → dest UID is the fresh account UID (counter: domain
    // 100/account 101, domain 102/account 103).
    expect(lines).toEqual([
      `A1 OK [COPYUID ${STORED_UIDVALIDITY} 5,7 101,103] COPY completed\r\n`,
    ]);
  });

  it("copies to the unified Sent folder with domain-space dest UIDs (#702)", async () => {
    // The unified "Sent Messages" folder is domain-scoped (resolveBox →
    // accountName=null → uid_domain). COPYUID's dest-set must therefore report
    // the DOMAIN counter (100, 102), not the account counter (101, 103) — the
    // isDomainScoped fix. Source is INBOX (also domain-scoped) → source-set is
    // the source domain UIDs 5,7.
    const mails = [
      sourceMail({ domain: 5, account: 50 }),
      sourceMail({ domain: 7, account: 70 }),
    ];
    const { store, stored } = makeCopyStore(["Sent Messages"], mails);
    const lines = await runCopy(
      copyReq("Sent Messages", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      { store, storeMailCalls: stored }
    );
    expect(stored.length).toBe(2);
    expect(lines).toEqual([
      `A1 OK [COPYUID ${STORED_UIDVALIDITY} 5,7 100,102] COPY completed\r\n`,
    ]);
  });
});

describe("COPY COPYUID positional pairing — out-of-order set (#624, RFC 4315 §3)", () => {
  it("pairs the n-th source UID with the n-th dest UID for a non-ascending sequence-set", async () => {
    // `UID COPY 5,3` — client lists the higher UID first. getMessages
    // returns the mails in that copy order (uid 5 then uid 3). The fix
    // sorts the source mails ascending before assigning dest UIDs so the
    // COPYUID source-set and dest-set (each independently sorted by
    // `formatUidSet`) report the REAL mapping, not an inverted one.
    const mails = [
      sourceMail({ domain: 5, account: 50 }),
      sourceMail({ domain: 3, account: 30 }),
    ];
    const { store, stored } = makeCopyStore(["Archive"], mails);
    const lines = await runCopy(
      copyReq("Archive", { type: "uid", ranges: [{ start: 3, end: 5 }] }),
      true,
      { store, storeMailCalls: stored }
    );

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

    expect(stored.length).toBe(2);
    const actualDestOf = (srcUid: number): number =>
      stored.find((c) => c.subject === `src-${srcUid}`)!.uid!.account;

    // COPYUID must report the real source→dest mapping.
    expect(claimedPairing.get(3)).toBe(actualDestOf(3));
    expect(claimedPairing.get(5)).toBe(actualDestOf(5));
    expect(actualDestOf(3)).toBeLessThan(actualDestOf(5));
  });
});

describe("COPY overlapping ranges — dedupe by source UID (#626, RFC 4315 §3)", () => {
  it("clones each distinct source UID once and keeps COPYUID src/dest set lengths equal", async () => {
    // `UID COPY 3:5,4:6` — the ranges overlap on UIDs 4 and 5. The handler
    // calls getMessages once per range, so an overlapping UID is materialized
    // twice. Without the dedupe, each such UID is cloned twice (a duplicate
    // stored message) AND the COPYUID response desyncs: `formatUidSet`
    // collapses the source set via `new Set` but the dest set keeps every
    // clone, so srcSet.length < destSet.length and the positional pairing is
    // unparseable. The fix drops repeats so each distinct source UID is
    // copied exactly once.
    const all = [
      sourceMail({ domain: 3, account: 30 }),
      sourceMail({ domain: 4, account: 40 }),
      sourceMail({ domain: 5, account: 50 }),
      sourceMail({ domain: 6, account: 60 }),
    ];
    const { store, stored } = makeCopyStore(["Archive"], all);
    // Range-aware getMessages so only the overlap (4,5) is returned twice —
    // faithfully modeling the wire behavior rather than duplicating everything.
    store.getMessages = async (
      _box: never,
      start: never,
      end: never
    ) => {
      const map = new Map<number, Partial<MailType>>();
      all
        .filter((m) => m.uid!.domain >= (start as number) && m.uid!.domain <= (end as number))
        .forEach((m, i) => map.set(i, m));
      return map as never;
    };

    const lines = await runCopy(
      copyReq("Archive", {
        type: "uid",
        ranges: [
          { start: 3, end: 5 },
          { start: 4, end: 6 },
        ],
      }),
      true,
      { store, storeMailCalls: stored }
    );

    expect(stored.length).toBe(4);
    const storedSubjects = stored.map((c) => c.subject).sort();
    expect(storedSubjects).toEqual(["src-3", "src-4", "src-5", "src-6"]);

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
    expect(srcSet.length).toBe(4);

    // Positional COPYUID mapping resolves to the real stored dest UID.
    const claimedPairing = new Map<number, number>();
    srcSet.forEach((s, i) => claimedPairing.set(s, destSet[i]));
    const actualDestOf = (srcUid: number): number =>
      stored.find((c) => c.subject === `src-${srcUid}`)!.uid!.account;
    [3, 4, 5, 6].forEach((u) =>
      expect(claimedPairing.get(u)).toBe(actualDestOf(u))
    );
  });
});

describe("COPY dispatch — sequence vs UID semantics (#520)", () => {
  it("UID COPY consumes the sequenceSet as UIDs (no seqState lookup)", async () => {
    const ctx = buildStore({ existsBoxes: ["Archive"] });
    // Empty seqState — if the code path mistakenly went through
    // resolveSeqRangeToUids it would get null and produce an empty
    // result. Since this is UID COPY, the range pass-through means
    // getMessages IS called (and returns []).
    let getMessagesCalled = false;
    ctx.store.getMessages = async (
      _box: string,
      _start: number,
      _end: number,
      _fields: string[],
      useUid: boolean
    ) => {
      getMessagesCalled = true;
      // Must be invoked with useUid=true for UID COPY.
      expect(useUid).toBe(true);
      return new Map();
    };
    await runCopy(
      copyReq("Archive", {
        type: "uid",
        ranges: [{ start: 10, end: 20 }],
      }),
      true,
      ctx
    );
    expect(getMessagesCalled).toBe(true);
  });

  it("sequence COPY without a populated seqState skips getMessages (no resolvable UIDs)", async () => {
    const ctx = buildStore({ existsBoxes: ["Archive"] });
    let getMessagesCalled = false;
    ctx.store.getMessages = async () => {
      getMessagesCalled = true;
      return new Map();
    };
    await runCopy(
      copyReq("Archive", {
        type: "seq",
        ranges: [{ start: 1, end: 5 }],
      }),
      false,
      ctx,
      "INBOX",
      // seqState is empty: resolveSeqRangeToUids returns null, the
      // range gets skipped before getMessages is called.
      emptySeqState()
    );
    expect(getMessagesCalled).toBe(false);
  });
});

describe("COPY address routing into a utility folder (#725)", () => {
  it("keeps the source recipient — a utility folder selects on the flag, not the address", async () => {
    const mails = [sourceMail({ domain: 5, account: 50 })];
    const { store, stored } = makeCopyStore(["Junk"], mails);
    await runCopy(
      copyReq("Junk", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      { store, storeMailCalls: stored }
    );
    expect(stored[0].to?.value).toEqual([{ address: "src@hoie.kim", name: "" }]);
    expect(stored[0].envelopeTo).toEqual([{ address: "src@hoie.kim", name: "" }]);
  });

  it("keeps the source recipient for Drafts too, case-insensitively", async () => {
    // The client names the box in lowercase; `canonicalMailbox` resolves it to
    // the listed spelling before the existence gate, so the copy still lands.
    const mails = [sourceMail({ domain: 5, account: 50 })];
    const { store, stored } = makeCopyStore(["Drafts"], mails);
    await runCopy(
      copyReq("drafts", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      { store, storeMailCalls: stored }
    );
    expect(stored[0].to?.value).toEqual([{ address: "src@hoie.kim", name: "" }]);
    expect(stored[0].envelopeTo).toEqual([{ address: "src@hoie.kim", name: "" }]);
  });

  it("still re-anchors to the destination account for an address-filtered box", async () => {
    const mails = [sourceMail({ domain: 5, account: 50 })];
    const { store, stored } = makeCopyStore(["Archive"], mails);
    await runCopy(
      copyReq("Archive", { type: "uid", ranges: [{ start: 1, end: 100 }] }),
      true,
      { store, storeMailCalls: stored }
    );
    const destAddress = boxToAccount(VALID_USER.username, "Archive");
    expect(stored[0].to?.value).toEqual([{ address: destAddress, name: "" }]);
    expect(stored[0].envelopeTo).toEqual([{ address: destAddress, name: "" }]);
  });
});
