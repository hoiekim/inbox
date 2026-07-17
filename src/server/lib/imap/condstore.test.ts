/**
 * Tests for IMAP CONDSTORE phase 2 (RFC 4551) — inbox #608.
 *
 * The "visible-tracking layer": the client can READ mod-sequence state but not
 * yet USE it for incremental sync (phase 3) or conflict detection (phase 4).
 * Coverage:
 *  - CAPABILITY advertises CONDSTORE.
 *  - Parser accepts the MODSEQ fetch item, the HIGHESTMODSEQ status item, and
 *    ENABLE CONDSTORE.
 *  - ENABLE CONDSTORE echoes `* ENABLED CONDSTORE` and flips the session flag
 *    (idempotent on re-enable).
 *  - SELECT / EXAMINE include `* OK [HIGHESTMODSEQ N]`.
 *  - STATUS supports the HIGHESTMODSEQ item.
 *  - FETCH emits `MODSEQ (n)` when requested, implicitly on every response once
 *    CONDSTORE is enabled, and exactly once when both apply.
 *  - STORE's untagged FETCH carries MODSEQ once CONDSTORE is enabled.
 *
 * Isolation mirrors message-ops.test.ts: mock `pg` so the lazy pool in
 * postgres/client.ts is a FakePool, then run the REAL imap code (selectMailbox
 * reaches getImapUidValidity, which queries Postgres). No mock of the `server`
 * barrel (which would bleed across files via Bun's process-global mock.module).
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  afterAll,
} from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { MailType, SignedUser } from "common";
import type { Store } from "./store";
import type { SequenceState } from "./sequence-resolver";
import type { FetchDataItem, StoreRequest } from "./types";

const STORED_UIDVALIDITY = 1716512400;

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
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: "10" }], rowCount: 1 };
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

mock.module("pg", pgMock);

const { getCapabilities } = await import("./capabilities");
const { parseCommand } = await import("./parsers");
const { buildFetchResponse } = await import("./fetch-helpers");
const { selectMailbox, statusMailbox } = await import("./mailbox-ops");
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
// CAPABILITY
// ---------------------------------------------------------------------------

describe("CONDSTORE — CAPABILITY", () => {
  it("advertises CONDSTORE on the plain port", () => {
    expect(getCapabilities(false).split(" ")).toContain("CONDSTORE");
  });

  it("advertises CONDSTORE on the TLS-wrapped port", () => {
    expect(getCapabilities(true).split(" ")).toContain("CONDSTORE");
  });
});

// ---------------------------------------------------------------------------
// Parser tokens
// ---------------------------------------------------------------------------

describe("CONDSTORE — parser tokens", () => {
  it("parses the MODSEQ fetch item", () => {
    const result = parseCommand("A1 FETCH 1 (FLAGS MODSEQ)");
    expect(result.success).toBe(true);
    if (result.value?.request.type !== "FETCH") throw new Error("not FETCH");
    const items = result.value.request.data.dataItems as FetchDataItem[];
    expect(items.map((i) => i.type)).toContain("MODSEQ");
  });

  it("parses the HIGHESTMODSEQ status item", () => {
    const result = parseCommand("A1 STATUS INBOX (MESSAGES HIGHESTMODSEQ)");
    expect(result.success).toBe(true);
    if (result.value?.request.type !== "STATUS") throw new Error("not STATUS");
    expect(result.value.request.data.items).toContain("HIGHESTMODSEQ");
  });

  it("parses ENABLE CONDSTORE", () => {
    const result = parseCommand("A1 ENABLE CONDSTORE");
    expect(result.success).toBe(true);
    if (result.value?.request.type !== "ENABLE") throw new Error("not ENABLE");
    expect(result.value.request.data.capabilities).toContain("CONDSTORE");
  });
});

// ---------------------------------------------------------------------------
// ENABLE handshake (RFC 5161 / RFC 4551 §3.7)
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
  const handler = { isTls: false } as never;
  const session = new ImapSession(handler, socket as never);
  return { session, writes };
};

describe("CONDSTORE — ENABLE handshake", () => {
  it("echoes `* ENABLED CONDSTORE` for ENABLE CONDSTORE", () => {
    const { session, writes } = makeSession();
    session.enable("A1", ["CONDSTORE"]);
    expect(writes.join("")).toBe(
      "* ENABLED CONDSTORE\r\nA1 OK ENABLE completed\r\n"
    );
  });

  it("echoes an empty `* ENABLED` for an unknown extension", () => {
    const { session, writes } = makeSession();
    session.enable("A1", ["FOOBAR"]);
    expect(writes.join("")).toBe("* ENABLED\r\nA1 OK ENABLE completed\r\n");
  });

  it("re-enabling CONDSTORE is idempotent (nothing new to echo)", () => {
    const { session, writes } = makeSession();
    session.enable("A1", ["CONDSTORE"]);
    session.enable("A2", ["CONDSTORE"]);
    expect(writes[writes.length - 1]).toContain("A2 OK ENABLE completed");
    expect(writes.filter((w) => w.includes("ENABLED CONDSTORE")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SELECT / EXAMINE — HIGHESTMODSEQ response code
// ---------------------------------------------------------------------------

const fakeSelectStore = (highest: number): Store =>
  ({
    mailboxExists: async () => true,
    countMessages: async () => ({ total: 2, unread: 0, maxUid: 9 }),
    getAllUids: async () => [8, 9],
    getFirstUnseenUid: async () => null,
    getHighestModseq: async () => highest,
    getUser: () => ({ id: "user-123", username: "admin" } as SignedUser),
  }) as unknown as Store;

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

const runSelect = async (readOnly: boolean, highest: number) => {
  const lines: string[] = [];
  await selectMailbox(
    "A1",
    "INBOX",
    readOnly,
    fakeSelectStore(highest),
    (data: string) => {
      lines.push(data);
      return true;
    },
    emptySeqState(),
    () => {},
    () => {}
  );
  return lines.join("");
};

describe("CONDSTORE — SELECT / EXAMINE HIGHESTMODSEQ", () => {
  it("SELECT includes `* OK [HIGHESTMODSEQ N]` before the tagged OK", async () => {
    const out = await runSelect(false, 42);
    expect(out).toContain("* OK [HIGHESTMODSEQ 42] Highest mod-sequence\r\n");
    const modseqIdx = out.indexOf("[HIGHESTMODSEQ 42]");
    const taggedIdx = out.indexOf("A1 OK [READ-WRITE]");
    expect(modseqIdx).toBeGreaterThan(-1);
    expect(modseqIdx).toBeLessThan(taggedIdx);
  });

  it("EXAMINE (read-only) also reports HIGHESTMODSEQ", async () => {
    const out = await runSelect(true, 7);
    expect(out).toContain("* OK [HIGHESTMODSEQ 7] Highest mod-sequence\r\n");
    expect(out).toContain("A1 OK [READ-ONLY] EXAMINE completed\r\n");
  });
});

// ---------------------------------------------------------------------------
// STATUS — HIGHESTMODSEQ item
// ---------------------------------------------------------------------------

const fakeStatusStore = (highest: number): Store =>
  ({
    mailboxExists: async () => true,
    countMessages: async () => ({ total: 3, unread: 1, maxUid: 5 }),
    getHighestModseq: async () => highest,
    getUser: () => ({ id: "user-123", username: "admin" } as SignedUser),
  }) as unknown as Store;

describe("CONDSTORE — STATUS HIGHESTMODSEQ", () => {
  it("includes HIGHESTMODSEQ in the STATUS response when requested", async () => {
    const lines: string[] = [];
    await statusMailbox(
      "A1",
      "INBOX",
      ["MESSAGES", "HIGHESTMODSEQ"],
      fakeStatusStore(99),
      (data: string) => {
        lines.push(data);
        return true;
      }
    );
    expect(lines).toContain('* STATUS "INBOX" (MESSAGES 3 HIGHESTMODSEQ 99)\r\n');
    expect(lines).toContain("A1 OK STATUS completed\r\n");
  });
});

// ---------------------------------------------------------------------------
// FETCH — MODSEQ emission (buildFetchResponse is the single response builder)
// ---------------------------------------------------------------------------

const mailWithModseq = (modseq: number | undefined): Partial<MailType> => ({
  uid: { domain: 5, account: 5 },
  modseq,
  read: true,
  saved: false,
  deleted: false,
  draft: false,
  answered: false,
});

const modseqParts = (parts: { type: string; content?: string }[]) =>
  parts.filter((p) => p.type === "simple" && p.content?.startsWith("MODSEQ"));

describe("CONDSTORE — FETCH MODSEQ emission", () => {
  it("omits MODSEQ when neither requested nor CONDSTORE-enabled", async () => {
    const parts = await buildFetchResponse(
      mailWithModseq(42),
      [{ type: "FLAGS" }],
      "doc1",
      5,
      true,
      "INBOX",
      false
    );
    expect(modseqParts(parts)).toHaveLength(0);
  });

  it("emits `MODSEQ (n)` when the client requests it explicitly", async () => {
    const parts = await buildFetchResponse(
      mailWithModseq(42),
      [{ type: "FLAGS" }, { type: "MODSEQ" }],
      "doc1",
      5,
      true,
      "INBOX",
      false
    );
    const m = modseqParts(parts);
    expect(m).toHaveLength(1);
    expect(m[0].content).toBe("MODSEQ (42)");
  });

  it("emits MODSEQ implicitly on every response once CONDSTORE is enabled", async () => {
    const parts = await buildFetchResponse(
      mailWithModseq(42),
      [{ type: "FLAGS" }],
      "doc1",
      5,
      true,
      "INBOX",
      true
    );
    const m = modseqParts(parts);
    expect(m).toHaveLength(1);
    expect(m[0].content).toBe("MODSEQ (42)");
  });

  it("emits MODSEQ exactly once when both requested AND CONDSTORE-enabled", async () => {
    const parts = await buildFetchResponse(
      mailWithModseq(42),
      [{ type: "MODSEQ" }, { type: "FLAGS" }],
      "doc1",
      5,
      true,
      "INBOX",
      true
    );
    expect(modseqParts(parts)).toHaveLength(1);
  });

  it("omits MODSEQ when the mail row carries no mod-sequence", async () => {
    const parts = await buildFetchResponse(
      mailWithModseq(undefined),
      [{ type: "MODSEQ" }],
      "doc1",
      5,
      true,
      "INBOX",
      true
    );
    expect(modseqParts(parts)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// STORE — untagged FETCH carries MODSEQ once CONDSTORE is enabled
// ---------------------------------------------------------------------------

const makeFlagStore = (
  result: { uid: number; read: boolean; modseq: number }[]
): Store =>
  ({
    setFlags: async () => result,
  }) as unknown as Store;

const seqStateFor = (uids: number[]): SequenceState => {
  const uidToSeq = new Map<number, number>();
  uids.forEach((uid, i) => uidToSeq.set(uid, i + 1));
  return { seqToUid: uids, uidToSeq };
};

const uidStoreRequest = (uid: number): StoreRequest => ({
  sequenceSet: { type: "uid", ranges: [{ start: uid }] },
  operation: "+FLAGS",
  flags: ["\\Seen"],
});

const runStore = async (condstoreEnabled: boolean) => {
  const lines: string[] = [];
  const store = makeFlagStore([
    { uid: 8, read: true, modseq: 77 },
  ]);
  await storeFlagsTyped(
    "A1",
    uidStoreRequest(8),
    true,
    store,
    "INBOX",
    false,
    seqStateFor([8]),
    (data: string) => {
      lines.push(data);
      return true;
    },
    condstoreEnabled
  );
  return lines.join("");
};

describe("CONDSTORE — STORE flag echo carries MODSEQ", () => {
  it("appends `MODSEQ (n)` to the untagged FETCH when CONDSTORE is enabled", async () => {
    const out = await runStore(true);
    expect(out).toContain(
      "* 1 FETCH (UID 8 FLAGS (\\Seen) MODSEQ (77))\r\n"
    );
  });

  it("omits MODSEQ from the flag echo when CONDSTORE is not enabled", async () => {
    const out = await runStore(false);
    expect(out).toContain("* 1 FETCH (UID 8 FLAGS (\\Seen))\r\n");
    expect(out).not.toContain("MODSEQ");
  });
});
