/**
 * Tests for `moveMessageTyped` (#453, RFC 6851).
 *
 * MOVE composes COPY + STORE \\Deleted + EXPUNGE. The COPY-phase logic
 * mirrors `copyMessageTyped` (post-#604 round-2: fresh messageId, `sent`
 * arg threading, envelope_to / cc / bcc re-anchor). Tests here focus on
 * the MOVE-specific surface: read-only refusal, TRYCREATE, no-op
 * range cases. End-to-end "real source mails → COPYUID + EXPUNGE
 * emission" needs a FakePool fixture (same as the COPY it.todo).
 */

import { describe, it, expect } from "bun:test";
import type { SignedUser } from "common";
import { moveMessageTyped } from "./message-ops";
import { Store } from "./store";
import type { MoveRequest } from "./types";
import type { SequenceState } from "./sequence-resolver";

const VALID_USER: SignedUser = { id: "u1", username: "admin" } as SignedUser;

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

describe("MOVE happy path (#453)", () => {
  it.todo(
    "moves source mails, marks them \\\\Deleted, expunges, emits COPYUID + EXPUNGE (FakePool fixture needed)"
  );
});
