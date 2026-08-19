
/** The two mapped-utility mailbox names — kept in sync with the same
 * literals in `./core` (which cannot import from here at load time via a
 * name cycle would be fine; the constants are colocated with the sync
 * effect there). `canonicalMailbox` at the wire boundary normalizes to
 * these spellings before any pivot decision runs. */
export const STARRED_MAILBOX = "Starred";
export const TRASH_MAILBOX = "Trash";

/**
 * One pivot write the caller should issue for a saveMail row — `mailbox` is
 * the mapped-utility name (Starred / Trash), `present` is the target flag
 * value.
 */
export type MappedPivotDecision = { mailbox: string; present: boolean };

/**
 * The gating logic behind `syncMappedPivotsForRow`. Returns the pivot
 * writes the caller should issue, in order.
 *
 * - `saved === undefined` / `deleted === undefined` → skip the corresponding
 *   pivot. The INSERT branch of saveMail uses this for a false-flag fresh
 *   row that never had a pivot to remove; the merge branch uses it for
 *   flags the incoming placement didn't touch (invariant already held
 *   pre-write, no flag flip means it still holds).
 * - `destMailbox === STARRED_MAILBOX` / `TRASH_MAILBOX` → skip that pivot.
 *   The caller's own `writeMailboxUid` above (for the reserved UID) already
 *   handled that pivot, so calling `syncMailboxPivot` on top would waste a
 *   counter tick on an ON CONFLICT DO UPDATE that keeps the same uid.
 */
export const decideMappedPivots = (
  saved: boolean | undefined,
  deleted: boolean | undefined,
  destMailbox: string | undefined
): MappedPivotDecision[] => {
  const decisions: MappedPivotDecision[] = [];
  if (saved !== undefined && destMailbox !== STARRED_MAILBOX) {
    decisions.push({ mailbox: STARRED_MAILBOX, present: saved });
  }
  if (deleted !== undefined && destMailbox !== TRASH_MAILBOX) {
    decisions.push({ mailbox: TRASH_MAILBOX, present: deleted });
  }
  return decisions;
};
