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

/**
 * Resolve a message-sequence range [start, end] to UID bounds for a store query.
 *
 * RFC 3501 §6.4.5/§9: an endpoint beyond the largest message number is not an
 * error — it is clamped to the last message and the in-range messages are still
 * returned. The previous behaviour (resolve each endpoint independently, drop
 * the whole range if either is undefined) silently matched nothing whenever the
 * upper bound exceeded the mailbox size (e.g. `11320:11400` on 11322 messages).
 *
 * Returns undefined only when the range starts past the end of the mailbox (no
 * messages match) or the mailbox is empty. '*' (MAX_SAFE_INTEGER) clamps to the
 * last message. Endpoint ordering is left as-is; descending ranges are handled
 * separately in convertSequenceSet (issue #582).
 *
 * '*' means "the highest message in the mailbox" (RFC 3501 §9), so a `*` start
 * clamps to the last message like `end` does — `SEARCH *` / `FETCH *` target
 * the final message. This is exempt from the out-of-range guard: a *concrete*
 * sequence number past the end (e.g. `SEARCH 99999` on a 3-message mailbox)
 * must still match nothing, so only the sentinel is let through (issue #660).
 */
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

/**
 * Resolve the '*' UID sentinel (MAX_SAFE_INTEGER) in a UID-axis range to the
 * mailbox's actual highest UID (RFC 3501 §9: '*' = highest UID in the
 * mailbox). Concrete UIDs pass through unchanged. Unlike the sequence-number
 * axis, an out-of-range concrete UID is not an error case — it simply
 * matches no messages — so this always returns a resolved pair rather than
 * undefined. On an empty mailbox the sentinel resolves to -1 (below any real
 * UID, which are ≥ 1) instead of leaving MAX_SAFE_INTEGER to overflow a
 * Postgres `integer` bind parameter (#678).
 */
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
 * Used for FETCH limit checks.
 */
export function countSequenceSetMessages(seqToUid: number[], sequenceSet: SequenceSet): number {
  const maxSeq = seqToUid.length;
  let count = 0;
  for (const range of sequenceSet.ranges) {
    if (range.end === undefined) {
      count += 1;
    } else {
      const effectiveEnd = Math.min(range.end, maxSeq);
      const effectiveStart = Math.min(range.start, maxSeq);
      count += Math.max(0, effectiveEnd - effectiveStart + 1);
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
 *    emit a single range enclosing them. Non-contiguous UIDs inside
 *    that range simply match nothing downstream — correct.
 */
export function clampSequenceSetToFirst(
  seqToUid: number[],
  sequenceSet: SequenceSet,
  limit: number,
  isUidCommand: boolean
): SequenceSet {
  if (limit <= 0) return { ...sequenceSet, ranges: [] };

  if (isUidCommand) {
    const matched: number[] = [];
    outer: for (const range of sequenceSet.ranges) {
      const startUid = range.start;
      const endUid = range.end ?? range.start;
      for (const uid of seqToUid) {
        if (uid >= startUid && uid <= endUid) {
          matched.push(uid);
          if (matched.length >= limit) break outer;
        }
      }
    }
    if (matched.length === 0) return { ...sequenceSet, ranges: [] };
    return {
      ...sequenceSet,
      ranges: [{ start: matched[0], end: matched[matched.length - 1] }],
    };
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
    const effectiveStart = Math.min(range.start, maxSeq);
    const effectiveEnd = Math.min(range.end, maxSeq);
    const rangeCount = Math.max(0, effectiveEnd - effectiveStart + 1);
    if (rangeCount === 0) continue;
    if (rangeCount <= remaining) {
      clamped.push(range);
      remaining -= rangeCount;
    } else {
      clamped.push({ start: range.start, end: effectiveStart + remaining - 1 });
      remaining = 0;
    }
  }
  return { ...sequenceSet, ranges: clamped };
}
