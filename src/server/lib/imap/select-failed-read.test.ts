import { describe, it, expect } from "bun:test";
import { Store } from "./store";
import { selectMailbox } from "./mailbox-ops";
import type { SignedUser } from "common";
import type { SequenceState } from "./sequence-resolver";

const fakeStore = (getAllUids: () => Promise<number[] | null>): Store =>
  ({
    mailboxExists: async () => true,
    countMessages: async () => ({ total: 3, unread: 0, maxUid: 30 }),
    getAllUids,
    getFirstUnseenUid: async () => null,
    getUser: () => ({ id: "u1", username: "admin" }) as SignedUser,
  }) as unknown as Store;

const seqStateFor = (uids: number[]): SequenceState => ({
  seqToUid: [...uids],
  uidToSeq: new Map(uids.map((uid, index) => [uid, index + 1])),
});

// The fake Store can't reach the OK-response tail (`getImapUidValidity` hits
// postgres directly rather than going through the store), so these assert on
// everything SELECT does before that point.
const runSelect = async (
  getAllUids: () => Promise<number[] | null>,
  seqState: SequenceState
) => {
  const lines: string[] = [];
  const selected: Array<{ mailbox: string | null; count: number }> = [];
  let cleared = 0;
  await selectMailbox(
    "A1",
    "INBOX",
    false,
    fakeStore(getAllUids),
    (data: string) => {
      lines.push(data);
      return true;
    },
    seqState,
    (mailbox, count) => selected.push({ mailbox, count }),
    () => {
      cleared++;
    }
  );
  return { lines, selected, cleared };
};

describe("SELECT on a mailbox whose UID read fails", () => {
  it("answers NO and deselects rather than keeping a stale mapping", async () => {
    const seqState = seqStateFor([10, 20, 30]);
    const { lines, selected, cleared } = await runSelect(
      async () => null,
      seqState
    );

    expect(lines).toEqual(["A1 NO Failed to read mailbox\r\n"]);
    expect(selected.at(-1)).toEqual({ mailbox: null, count: 0 });
    expect(cleared).toBe(1);
  });

  it("keeps selecting when the read succeeds", async () => {
    const seqState = seqStateFor([]);
    const { lines, selected, cleared } = await runSelect(
      async () => [10, 20, 30],
      seqState
    );

    expect(lines.some((line) => line.includes("NO Failed to read mailbox"))).toBe(false);
    expect(selected.at(-1)).toEqual({ mailbox: "INBOX", count: 3 });
    expect(cleared).toBe(0);
    expect(seqState.seqToUid).toEqual([10, 20, 30]);
    expect(seqState.uidToSeq.get(30)).toBe(3);
  });
});
