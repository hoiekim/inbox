/**
 * Sequence number ↔ UID mapping helpers.
 *
 * Per RFC 3501, sequence numbers are contiguous 1..N and must be rebuilt
 * whenever the mailbox changes (SELECT, EXPUNGE, APPEND, etc.).
 */

import { Store } from "./store";
import { SequenceSet, SequenceRange } from "./types";

/**
 * Mutable sequence state held on ImapSession.
 * Passed by reference so mutations are reflected back on the session.
 */
export interface SequenceState {
  seqToUid: number[];
  uidToSeq: Map<number, number>;
}

/**
 * Build sequence number → UID mapping for the selected mailbox.
 * Mutates `state.seqToUid` and `state.uidToSeq` in place.
 */
export async function buildSequenceMapping(
  store: Store | null,
  selectedMailbox: string | null,
  state: SequenceState
): Promise<void> {
  if (!store || !selectedMailbox) {
    state.seqToUid = [];
    state.uidToSeq.clear();
    return;
  }

  const uids = await store.getAllUids(selectedMailbox);
  state.seqToUid = uids;
  state.uidToSeq.clear();
  for (let i = 0; i < uids.length; i++) {
    state.uidToSeq.set(uids[i], i + 1); // seq numbers are 1-indexed
  }
}

/**
 * Convert a sequence number to UID.
 * Handles '*' (represented as MAX_SAFE_INTEGER) by returning the highest UID.
 */
export function seqToUidNumber(seqToUid: number[], seq: number): number | undefined {
  if (seq === Number.MAX_SAFE_INTEGER) {
    return seqToUid[seqToUid.length - 1];
  }
  return seqToUid[seq - 1]; // seq is 1-indexed, array is 0-indexed
}

export function resolveSeqRangeToUids(
  seqToUid: number[],
  start: number,
  end: number
): { uidStart: number; uidEnd: number } | undefined {
  const maxSeq = seqToUid.length;
  if (maxSeq === 0) return undefined;
  if (start !== Number.MAX_SAFE_INTEGER && start > maxSeq) return undefined;
  const uidStart = seqToUidNumber(seqToUid, Math.min(start, maxSeq));
  const uidEnd = seqToUidNumber(seqToUid, Math.min(end, maxSeq));
  if (uidStart === undefined || uidEnd === undefined) return undefined;
  return { uidStart, uidEnd };
}

/**
 * Convert a UID to sequence number.
 * Handles '*' (represented as MAX_SAFE_INTEGER) by returning the highest seq.
 */
export function uidToSeqNumber(
  seqToUid: number[],
  uidToSeq: Map<number, number>,
  uid: number
): number | undefined {
  if (uid === Number.MAX_SAFE_INTEGER) {
    return seqToUid.length;
  }
  return uidToSeq.get(uid);
}

export function resolveUidRangeSentinel(
  seqToUid: number[],
  start: number,
  end: number
): { uidStart: number; uidEnd: number } {
  const maxUid = seqToUid.length > 0 ? seqToUid[seqToUid.length - 1] : -1;
  const resolve = (value: number) =>
    value === Number.MAX_SAFE_INTEGER ? maxUid : value;
  return { uidStart: resolve(start), uidEnd: resolve(end) };
}

/**
 * Count messages covered by a sequence set (clamped to actual mailbox size).
 * Used for FETCH limit checks — feeds the `requestedCount > cap` gate in
 * `fetchMessagesTyped`, so mis-counting = clamp skipped = cap bypassed.
 *
 * `isUidCommand` mirrors the split in `clampSequenceSetToFirst` above:
 * the parser stamps every set with `type: "sequence"`, so the caller is
 * the source of truth for axis. On the UID axis a seq-position-based
 * count is wrong twice over: `UID FETCH 10051:*` on a pruned mailbox
 * (UIDs 10001..19950) counts 1 (seq-clamp of 10051 → maxSeq → 1) even
 * though the request covers 9900 real UIDs; downstream then over-fetches
 * because the cap gate never fired. Instead, intersect each range with
 * `seqToUid` (already monotonic per RFC 3501 §2.3.1.1) via binary search
 * so each range is O(log N) rather than O(N).
 */
export function countSequenceSetMessages(
  seqToUid: number[],
  sequenceSet: SequenceSet,
  isUidCommand: boolean
): number {
  if (isUidCommand) {
    if (seqToUid.length === 0) return 0;
    const maxUid = seqToUid[seqToUid.length - 1];
    let count = 0;
    for (const range of sequenceSet.ranges) {
      const rawStart = range.start;
      const rawEnd = range.end ?? range.start;
      // MAX_SAFE_INTEGER is the `*` sentinel — resolves to the highest UID.
      const startUid = rawStart === Number.MAX_SAFE_INTEGER ? maxUid : rawStart;
      const endUid = rawEnd === Number.MAX_SAFE_INTEGER ? maxUid : rawEnd;
      const lo = Math.min(startUid, endUid);
      const hi = Math.max(startUid, endUid);
      // First index >= lo.
      let left = 0;
      let right = seqToUid.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (seqToUid[mid] < lo) left = mid + 1;
        else right = mid;
      }
      const startIdx = left;
      // First index > hi.
      left = startIdx;
      right = seqToUid.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (seqToUid[mid] <= hi) left = mid + 1;
        else right = mid;
      }
      count += left - startIdx;
    }
    return count;
  }

  const maxSeq = seqToUid.length;
  let count = 0;
  for (const range of sequenceSet.ranges) {
    if (range.end === undefined) {
      count += 1;
    } else {
      const clampedEnd = Math.min(range.end, maxSeq);
      const clampedStart = Math.min(range.start, maxSeq);
      const lo = Math.min(clampedStart, clampedEnd);
      const hi = Math.max(clampedStart, clampedEnd);
      count += Math.max(0, hi - lo + 1);
    }
  }
  return count;
}

/**
 * Take the first `limit` messages from a sequence set, dropping the rest.
 * Used when a FETCH request would exceed the server's per-command message
 * cap — instead of refusing the whole request with `NO [LIMIT]`,
 * `fetchMessagesTyped` shrinks the set to what it will actually process.
 * RFC 3501 §6.4.5 lets the server return a subset of the requested
 * messages; clients then observe the uncovered range and issue a
 * follow-up FETCH for it, walking the mailbox in cap-sized chunks. iOS
 * Mail specifically treats `NO` as fatal ("Cannot Get Mail" modal);
 * returning a shortened `OK` avoids the modal entirely.
 *
 * `isUidCommand` distinguishes the two axes at the call site because the
 * parser sets `sequenceSet.type = "sequence"` unconditionally — the
 * actual UID vs seq discriminator is carried by `isUidCommand` from
 * `fetchMessagesTyped` (see message-ops.ts). The two branches emit
 * different shapes:
 *
 *  - SEQ-axis: ranges are seq positions. Walk them in order, keep whole
 *    ones up to the limit, partially take the next, drop the rest.
 *
 *  - UID-axis: ranges are UID values, but UIDs are not necessarily 1..N —
 *    a mailbox after retention pruning or a UIDVALIDITY bump may hold
 *    e.g. UIDs 10001..11000. Clamping `1:*` to `{start:1, end:50}`
 *    would resolve to zero rows downstream (silent data loss). Instead,
 *    walk `seqToUid` in order (UIDs are monotonic per RFC 3501 §2.3.1.1),
 *    keep the first `limit` that intersect the requested ranges, and
 *    emit coalesced sub-ranges of exactly those matched UIDs. A single
 *    enclosing range [matched[0]..matched[last]] would over-fetch: on a
 *    dense mailbox {10001..10010}, request `10001:10002,10005:10008`
 *    limit=4 matches [10001,10002,10005,10006] but the enclosure
 *    [10001..10006] would pull 10003/10004 too (breaching the cap by
 *    50%) and drop the caller-requested 10007/10008. Coalescing yields
 *    [{10001,10002},{10005,10006}] — downstream fetches exactly what
 *    survived the clamp.
 */
export function clampSequenceSetToFirst(
  seqToUid: number[],
  sequenceSet: SequenceSet,
  limit: number,
  isUidCommand: boolean
): SequenceSet {
  if (limit <= 0) return { ...sequenceSet, ranges: [] };

  if (isUidCommand) {
    if (seqToUid.length === 0) return { ...sequenceSet, ranges: [] };
    const maxUid = seqToUid[seqToUid.length - 1];
    const matched: number[] = [];
    outer: for (const range of sequenceSet.ranges) {
      // Symmetric with `countSequenceSetMessages` and `resolveUidRangeSentinel`:
      // resolve the `*` sentinel to the highest UID, then normalize
      // reversed ranges (RFC 3501 §9: `10:3` ≡ `3:10`). Without this
      // pair `UID FETCH *:10051` and `UID FETCH 19950:10051` never
      // matched a UID and silently zero-fetched, even though the
      // counter now correctly reports both as 9900-UID requests.
      const rawStart = range.start;
      const rawEnd = range.end ?? range.start;
      const startUidResolved = rawStart === Number.MAX_SAFE_INTEGER ? maxUid : rawStart;
      const endUidResolved = rawEnd === Number.MAX_SAFE_INTEGER ? maxUid : rawEnd;
      const lo = Math.min(startUidResolved, endUidResolved);
      const hi = Math.max(startUidResolved, endUidResolved);
      for (const uid of seqToUid) {
        if (uid >= lo && uid <= hi) {
          matched.push(uid);
          if (matched.length >= limit) break outer;
        }
      }
    }
    if (matched.length === 0) return { ...sequenceSet, ranges: [] };
    const coalesced: SequenceRange[] = [];
    let start = matched[0];
    let end = matched[0];
    for (let i = 1; i < matched.length; i++) {
      if (matched[i] === end + 1) {
        end = matched[i];
      } else {
        coalesced.push({ start, end });
        start = matched[i];
        end = matched[i];
      }
    }
    coalesced.push({ start, end });
    return { ...sequenceSet, ranges: coalesced };
  }

  const maxSeq = seqToUid.length;
  const clamped: SequenceRange[] = [];
  let remaining = limit;
  for (const range of sequenceSet.ranges) {
    if (remaining <= 0) break;
    if (range.end === undefined) {
      clamped.push(range);
      remaining -= 1;
      continue;
    }
    // Normalize reversed ranges (RFC 3501 §9: `*:1` ≡ `1:*`, `10:3` ≡
    // `3:10`) via `min`/`max` after the seq-clamp — symmetric with the
    // SEQ-axis counter and with `convertSequenceSet` in fetch-helpers.
    // Without this, the clamp sees `effectiveStart > effectiveEnd`, computes
    // rangeCount=0, skips the whole range, and emits a silent zero-fetch.
    const clampedStart = Math.min(range.start, maxSeq);
    const clampedEnd = Math.min(range.end, maxSeq);
    const lo = Math.min(clampedStart, clampedEnd);
    const hi = Math.max(clampedStart, clampedEnd);
    const rangeCount = Math.max(0, hi - lo + 1);
    if (rangeCount === 0) continue;
    if (rangeCount <= remaining) {
      clamped.push({ start: lo, end: hi });
      remaining -= rangeCount;
    } else {
      clamped.push({ start: lo, end: lo + remaining - 1 });
      remaining = 0;
    }
  }
  return { ...sequenceSet, ranges: clamped };
}
