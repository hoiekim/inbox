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
