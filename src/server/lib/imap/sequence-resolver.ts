/**
 * Sequence number ↔ UID mapping helpers.
 *
 * Per RFC 3501, sequence numbers are contiguous 1..N and must be rebuilt
 * whenever the mailbox changes (SELECT, EXPUNGE, APPEND, etc.).
 */

import { Store } from "./store";
import { SequenceSet } from "./types";

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
 */
export function resolveSeqRangeToUids(
  seqToUid: number[],
  start: number,
  end: number
): { uidStart: number; uidEnd: number } | undefined {
  const maxSeq = seqToUid.length;
  if (maxSeq === 0 || start > maxSeq) return undefined;
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
