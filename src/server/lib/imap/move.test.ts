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
 * Tests here focus on the MOVE-specific control flow: read-only
 * refusal, TRYCREATE, no-op range cases, MOVE-to-self short-circuit.
 * End-to-end "real source mails → COPYUID + targeted EXPUNGE
 * emission, and the INBOX-from-non-INBOX address-clearing invariant"
 * needs a FakePool fixture (same as COPY's it.todo).
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

describe("MOVE happy path (#453)", () => {
  it.todo(
    "moves source mails (fresh messageId, address routing cleared on non-INBOX dest AND on INBOX dest from a non-INBOX source), calls Store.expungeUids on the source set, emits COPYUID + targeted EXPUNGE (FakePool fixture needed)"
  );
});
