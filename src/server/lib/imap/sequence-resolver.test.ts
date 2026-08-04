import { describe, it, expect, mock } from "bun:test";
import {
  buildSequenceMapping,
  seqToUidNumber,
  uidToSeqNumber,
  resolveSeqRangeToUids,
  resolveUidRangeSentinel,
  countSequenceSetMessages,
  clampSequenceSetToFirst,
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

describe("resolveSeqRangeToUids (inbox #588)", () => {
  const uids = [10, 20, 30, 40, 50]; // maxSeq = 5

  it("resolves a fully in-range range to its UID bounds", () => {
    expect(resolveSeqRangeToUids(uids, 2, 4)).toEqual({ uidStart: 20, uidEnd: 40 });
  });

  it("clamps an upper bound past the end to the last message (the bug)", () => {
    // 3:80 on a 5-message mailbox must return messages 3..5, not nothing.
    expect(resolveSeqRangeToUids(uids, 3, 80)).toEqual({ uidStart: 30, uidEnd: 50 });
  });

  it("resolves N:* to the last message", () => {
    expect(resolveSeqRangeToUids(uids, 3, Number.MAX_SAFE_INTEGER)).toEqual({
      uidStart: 30,
      uidEnd: 50,
    });
  });

  it("resolves a single-message range", () => {
    expect(resolveSeqRangeToUids(uids, 5, 5)).toEqual({ uidStart: 50, uidEnd: 50 });
  });

  it("returns undefined when the whole range is past the end", () => {
    expect(resolveSeqRangeToUids(uids, 6, 9)).toBeUndefined();
  });

  it("returns undefined on an empty mailbox", () => {
    expect(resolveSeqRangeToUids([], 1, 10)).toBeUndefined();
  });

  // inbox #660: a bare `*` (both endpoints MAX_SAFE_INTEGER) targets the last
  // message, not nothing. The `*` sentinel start is exempt from the
  // out-of-range guard; a concrete past-end start still matches nothing.
  it("resolves a bare `*` (start and end are `*`) to the last message", () => {
    expect(
      resolveSeqRangeToUids(uids, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ).toEqual({ uidStart: 50, uidEnd: 50 });
  });

  it("resolves `*` to the last message on a single-message mailbox", () => {
    expect(
      resolveSeqRangeToUids([10], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ).toEqual({ uidStart: 10, uidEnd: 10 });
  });

  it("returns undefined for `*` on an empty mailbox", () => {
    expect(
      resolveSeqRangeToUids([], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ).toBeUndefined();
  });

  it("still returns undefined for a concrete past-end start (not the `*` sentinel)", () => {
    // `6:*` on a 5-message mailbox: the start (6) is a real number past the
    // end, so it matches nothing — only `*` itself is treated as the last msg.
    expect(resolveSeqRangeToUids(uids, 6, Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });
});

describe("resolveUidRangeSentinel (inbox #678)", () => {
  const uids = [10, 20, 30, 40, 50];

  it("passes concrete UIDs through unchanged", () => {
    expect(resolveUidRangeSentinel(uids, 20, 40)).toEqual({ uidStart: 20, uidEnd: 40 });
  });

  it("resolves a bare `*` (start and end are `*`) to the highest UID", () => {
    expect(
      resolveUidRangeSentinel(uids, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ).toEqual({ uidStart: 50, uidEnd: 50 });
  });

  it("resolves an open-ended `n:*` upper bound to the highest UID", () => {
    expect(resolveUidRangeSentinel(uids, 30, Number.MAX_SAFE_INTEGER)).toEqual({
      uidStart: 30,
      uidEnd: 50,
    });
  });

  // The regression this closes: `*` used to reach the SQL layer as the raw
  // Number.MAX_SAFE_INTEGER sentinel and overflow a Postgres `integer` bind
  // parameter (crashed hoie-inbox-1 via a `UID SEARCH *` retry loop, OOM'd
  // after ~9 min of the resulting tight failure loop).
  it("never leaves MAX_SAFE_INTEGER in the resolved pair", () => {
    const { uidStart, uidEnd } = resolveUidRangeSentinel(
      uids,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    );
    expect(uidStart).toBeLessThan(2147483647); // Postgres `integer` max (int4)
    expect(uidEnd).toBeLessThan(2147483647);
  });

  it("resolves `*` to -1 on an empty mailbox (no highest UID to resolve to)", () => {
    expect(
      resolveUidRangeSentinel([], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ).toEqual({ uidStart: -1, uidEnd: -1 });
  });

  it("a concrete out-of-range UID still passes through (matches nothing downstream)", () => {
    expect(resolveUidRangeSentinel(uids, 999999, 999999)).toEqual({
      uidStart: 999999,
      uidEnd: 999999,
    });
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

describe("clampSequenceSetToFirst — SEQ axis (isUidCommand=false)", () => {
  // 10-message mailbox; UIDs happen to be 101..110 (values don't matter
  // for SEQ-axis — clamp counts by position, not by UID value).
  const uids = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const set = (ranges: SequenceSet["ranges"]): SequenceSet => ({
    type: "sequence",
    ranges,
  });

  it("returns the original set unchanged when count is already at the limit", () => {
    expect(
      clampSequenceSetToFirst(uids, set([{ start: 1, end: 5 }]), 5, false).ranges
    ).toEqual([{ start: 1, end: 5 }]);
  });

  it("returns the original set unchanged when count is below the limit", () => {
    expect(
      clampSequenceSetToFirst(uids, set([{ start: 1, end: 3 }]), 50, false).ranges
    ).toEqual([{ start: 1, end: 3 }]);
  });

  it("truncates a single range that exceeds the limit", () => {
    expect(
      clampSequenceSetToFirst(uids, set([{ start: 1, end: 10 }]), 3, false).ranges
    ).toEqual([{ start: 1, end: 3 }]);
  });

  it("truncates `1:*` (Number.MAX_SAFE_INTEGER sentinel) to the first N", () => {
    expect(
      clampSequenceSetToFirst(
        uids,
        set([{ start: 1, end: Number.MAX_SAFE_INTEGER }]),
        4,
        false
      ).ranges
    ).toEqual([{ start: 1, end: 4 }]);
  });

  it("keeps whole ranges first, then partially takes the next", () => {
    // limit=5: take {1,2}, then partial {5..7} (3 of 4), drop {10}.
    expect(
      clampSequenceSetToFirst(
        uids,
        set([{ start: 1, end: 2 }, { start: 5, end: 8 }, { start: 10 }]),
        5,
        false
      ).ranges
    ).toEqual([{ start: 1, end: 2 }, { start: 5, end: 7 }]);
  });

  it("keeps single-message ranges (end===undefined) as-is until the limit", () => {
    expect(
      clampSequenceSetToFirst(
        uids,
        set([{ start: 3 }, { start: 5 }, { start: 7 }]),
        2,
        false
      ).ranges
    ).toEqual([{ start: 3 }, { start: 5 }]);
  });

  it("returns an empty ranges array when limit is 0", () => {
    expect(
      clampSequenceSetToFirst(uids, set([{ start: 1, end: 10 }]), 0, false).ranges
    ).toEqual([]);
  });
});

describe("clampSequenceSetToFirst — UID axis (isUidCommand=true)", () => {
  // The load-bearing case: mailbox UIDs don't start at 1 (retention prune
  // or UIDVALIDITY bump). SEQ-axis clamp would emit `{start:1, end:N}`
  // which downstream `store.getMessages(uidStart=1, uidEnd=N)` resolves
  // to zero rows — silent data loss. UID-axis clamp walks the actual UID
  // list and emits a range enclosing the first N intersecting UIDs.
  const uids = [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010];
  const set = (ranges: SequenceSet["ranges"]): SequenceSet => ({
    type: "sequence", // parser default even for UID commands
    ranges,
  });

  it("`UID 1:*` on a pruned mailbox emits a range of REAL UIDs, not seq positions", () => {
    // The R1 HIGH scenario: previously returned `{start:1, end:50}` and
    // silently matched zero rows. Now returns `{start:10001, end:10003}`
    // for limit=3 — the actual first-3 UIDs.
    const result = clampSequenceSetToFirst(
      uids,
      set([{ start: 1, end: Number.MAX_SAFE_INTEGER }]),
      3,
      true
    );
    expect(result.ranges).toEqual([{ start: 10001, end: 10003 }]);
  });

  it("takes only UIDs that intersect the requested range", () => {
    const result = clampSequenceSetToFirst(
      uids,
      set([{ start: 10005, end: 10008 }]),
      2,
      true
    );
    expect(result.ranges).toEqual([{ start: 10005, end: 10006 }]);
  });

  it("returns empty ranges when NO UIDs intersect the requested range", () => {
    // Range 1..50 on a mailbox with UIDs 10001..10010 — nothing matches.
    // Downstream `_fetchMessages` sees an empty ranges list and correctly
    // returns 0 messages, not the whole mailbox.
    const result = clampSequenceSetToFirst(
      uids,
      set([{ start: 1, end: 50 }]),
      3,
      true
    );
    expect(result.ranges).toEqual([]);
  });

  it("walks multiple ranges in order, stopping at limit", () => {
    const result = clampSequenceSetToFirst(
      uids,
      set([
        { start: 10001, end: 10002 }, // 2 UIDs
        { start: 10005, end: 10008 }, // 4 UIDs
      ]),
      4,
      true
    );
    // First 4 matched UIDs: 10001, 10002, 10005, 10006. Emitted as one
    // enclosing range [10001, 10006]; 10003/10004 don't exist in the
    // requested set, so downstream returns 4 rows.
    expect(result.ranges).toEqual([{ start: 10001, end: 10006 }]);
  });

  it("single-UID range (end=undefined) treats end as start", () => {
    const result = clampSequenceSetToFirst(
      uids,
      set([{ start: 10005 }]),
      3,
      true
    );
    expect(result.ranges).toEqual([{ start: 10005, end: 10005 }]);
  });

  it("empty mailbox returns empty ranges", () => {
    const result = clampSequenceSetToFirst(
      [],
      set([{ start: 1, end: Number.MAX_SAFE_INTEGER }]),
      50,
      true
    );
    expect(result.ranges).toEqual([]);
  });

  it("limit=0 returns empty ranges", () => {
    const result = clampSequenceSetToFirst(
      uids,
      set([{ start: 10001, end: 10010 }]),
      0,
      true
    );
    expect(result.ranges).toEqual([]);
  });
});
