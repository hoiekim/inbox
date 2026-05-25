import { describe, it, expect, mock } from "bun:test";
import {
  buildSequenceMapping,
  seqToUidNumber,
  uidToSeqNumber,
  countSequenceSetMessages,
  type SequenceState,
} from "./sequence-resolver";
import type { SequenceSet } from "./types";

const makeState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

describe("buildSequenceMapping", () => {
  it("populates seqToUid and uidToSeq from store UIDs", async () => {
    const state = makeState();
    const store = {
      getAllUids: mock(async () => [10, 20, 30]),
    } as unknown as import("./store").Store;

    await buildSequenceMapping(store, "INBOX", state);

    expect(state.seqToUid).toEqual([10, 20, 30]);
    expect(state.uidToSeq.get(10)).toBe(1);
    expect(state.uidToSeq.get(20)).toBe(2);
    expect(state.uidToSeq.get(30)).toBe(3);
  });

  it("clears mapping when store is null", async () => {
    const state = makeState();
    state.seqToUid = [1, 2, 3];
    state.uidToSeq.set(1, 1);

    await buildSequenceMapping(null, "INBOX", state);

    expect(state.seqToUid).toEqual([]);
    expect(state.uidToSeq.size).toBe(0);
  });

  it("clears mapping when selectedMailbox is null", async () => {
    const state = makeState();
    state.seqToUid = [1, 2, 3];
    state.uidToSeq.set(1, 1);
    const store = {} as unknown as import("./store").Store;

    await buildSequenceMapping(store, null, state);

    expect(state.seqToUid).toEqual([]);
    expect(state.uidToSeq.size).toBe(0);
  });

  it("replaces previous mapping on re-select", async () => {
    const state = makeState();
    state.seqToUid = [100];
    state.uidToSeq.set(100, 1);
    const store = {
      getAllUids: mock(async () => [5, 15]),
    } as unknown as import("./store").Store;

    await buildSequenceMapping(store, "Sent", state);

    expect(state.seqToUid).toEqual([5, 15]);
    expect(state.uidToSeq.has(100)).toBe(false);
    expect(state.uidToSeq.get(5)).toBe(1);
    expect(state.uidToSeq.get(15)).toBe(2);
  });
});

describe("seqToUidNumber", () => {
  const uids = [10, 20, 30, 40, 50];

  it("maps seq 1 to first UID", () => {
    expect(seqToUidNumber(uids, 1)).toBe(10);
  });

  it("maps seq N to Nth UID", () => {
    expect(seqToUidNumber(uids, 3)).toBe(30);
  });

  it("maps * (MAX_SAFE_INTEGER) to last UID", () => {
    expect(seqToUidNumber(uids, Number.MAX_SAFE_INTEGER)).toBe(50);
  });

  it("returns undefined for out-of-range seq", () => {
    expect(seqToUidNumber(uids, 6)).toBeUndefined();
  });

  it("returns undefined on empty mailbox", () => {
    expect(seqToUidNumber([], 1)).toBeUndefined();
  });

  it("returns undefined for * on empty mailbox", () => {
    expect(seqToUidNumber([], Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });
});

describe("uidToSeqNumber", () => {
  const uids = [10, 20, 30];
  const map = new Map([[10, 1], [20, 2], [30, 3]]);

  it("maps known UID to its seq number", () => {
    expect(uidToSeqNumber(uids, map, 20)).toBe(2);
  });

  it("maps * (MAX_SAFE_INTEGER) to highest seq", () => {
    expect(uidToSeqNumber(uids, map, Number.MAX_SAFE_INTEGER)).toBe(3);
  });

  it("returns undefined for unknown UID", () => {
    expect(uidToSeqNumber(uids, map, 99)).toBeUndefined();
  });

  it("returns 0 for * on empty mailbox", () => {
    expect(uidToSeqNumber([], new Map(), Number.MAX_SAFE_INTEGER)).toBe(0);
  });
});

describe("countSequenceSetMessages", () => {
  const uids = [10, 20, 30, 40, 50];

  it("counts a single-message range", () => {
    const set: SequenceSet = { ranges: [{ start: 2 }] };
    expect(countSequenceSetMessages(uids, set)).toBe(1);
  });

  it("counts a start:end range", () => {
    const set: SequenceSet = { ranges: [{ start: 2, end: 4 }] };
    expect(countSequenceSetMessages(uids, set)).toBe(3);
  });

  it("clamps ranges beyond mailbox size", () => {
    const set: SequenceSet = { ranges: [{ start: 3, end: 100 }] };
    expect(countSequenceSetMessages(uids, set)).toBe(3);
  });

  it("sums multiple ranges", () => {
    const set: SequenceSet = {
      ranges: [{ start: 1, end: 2 }, { start: 4 }],
    };
    expect(countSequenceSetMessages(uids, set)).toBe(3);
  });

  it("clamps both start and end to 0 on empty mailbox", () => {
    const set: SequenceSet = { ranges: [{ start: 1, end: 10 }] };
    expect(countSequenceSetMessages([], set)).toBe(1);
  });

  it("returns 0 for empty sequence set", () => {
    const set: SequenceSet = { ranges: [] };
    expect(countSequenceSetMessages(uids, set)).toBe(0);
  });
});
