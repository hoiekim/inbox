/**
 * Pure decision logic behind saveMail's mapped-utility pivot sync (#725).
 *
 * `decideMappedPivots` encodes the two axes that gate a pivot write:
 *   1. flag value — `undefined` skips (INSERT branch for false-flag fresh
 *      rows; merge branch for flags the placement didn't touch).
 *   2. destination match — a write into `Starred` / `Trash` itself already
 *      wrote that pivot via `writeMailboxUid` for the reserved UID, so the
 *      sync skips it to avoid a wasted counter tick.
 *
 * Pool-mock-free by design — the pool-facing sibling `syncMappedPivotsForRow`
 * is exercised end-to-end through `storeFlagsTyped` in `message-ops.test.ts`
 * ("Starred / Trash pivot sync (#725)"). Splitting the two keeps this file
 * from touching the fragile `mock.module` pool surface (see
 * `reference_bun_mock_module_global_hoisting.md`).
 */
import { describe, it, expect } from "bun:test";
import { decideMappedPivots } from "./core";

describe("decideMappedPivots — gating logic for mapped-utility pivot writes", () => {
  it("undefined flag = skip its pivot (INSERT-branch convention for false-flag fresh rows)", () => {
    expect(decideMappedPivots(undefined, undefined, undefined)).toEqual([]);
    expect(decideMappedPivots(undefined, undefined, "Archive")).toEqual([]);
  });

  it("saved = true → Starred pivot present; deleted = true → Trash pivot present", () => {
    // The primary INSERT-branch case: COPY of a starred mail into Archive
    // has to add both flags' pivots for the new mail row.
    expect(decideMappedPivots(true, true, "Archive")).toEqual([
      { mailbox: "Starred", present: true },
      { mailbox: "Trash", present: true },
    ]);
  });

  it("saved = false → Starred pivot cleared; deleted = false → Trash pivot cleared", () => {
    // Merge-branch case: an incoming placement flip from true to false has
    // to delete the existing pivot row so the invariant stays intact.
    expect(decideMappedPivots(false, false, undefined)).toEqual([
      { mailbox: "Starred", present: false },
      { mailbox: "Trash", present: false },
    ]);
  });

  it("skips Starred when the destination IS Starred — writeMailboxUid already wrote that pivot", () => {
    // A COPY into Starred: the destination pivot is written via
    // `writeMailboxUid(input.mailbox = 'Starred', reserved uid)` in saveMail
    // BEFORE the sync helper runs. Calling `syncMailboxPivot` on top would
    // fire `getMailboxUidNext` and then ON CONFLICT DO UPDATE the pivot back
    // to its existing uid — one wasted counter tick per COPY. The skip
    // prevents that.
    expect(decideMappedPivots(true, undefined, "Starred")).toEqual([]);
    // The Trash axis is orthogonal — a COPY into Starred that ALSO has
    // deleted=true (rare but legal) still needs the Trash pivot.
    expect(decideMappedPivots(true, true, "Starred")).toEqual([
      { mailbox: "Trash", present: true },
    ]);
  });

  it("skips Trash when the destination IS Trash — same wasteful-write reason", () => {
    expect(decideMappedPivots(undefined, true, "Trash")).toEqual([]);
    // Starred axis still fires — a COPY into Trash of a starred mail keeps
    // its Starred pivot in sync via the sibling.
    expect(decideMappedPivots(true, true, "Trash")).toEqual([
      { mailbox: "Starred", present: true },
    ]);
  });

  it("only issues the writes whose flag was actually touched — no phantom deletes on plain INSERTs", () => {
    // The INSERT branch calls this with `data.saved ? true : undefined` so
    // a fresh row with saved=false passes undefined and gets zero pivot
    // writes — no wasteful "delete a pivot that never existed" call.
    expect(decideMappedPivots(undefined, true, "Archive")).toEqual([
      { mailbox: "Trash", present: true },
    ]);
    expect(decideMappedPivots(true, undefined, "Archive")).toEqual([
      { mailbox: "Starred", present: true },
    ]);
  });

  it("case-sensitive on the destination — 'starred' (lowercase) does NOT skip", () => {
    // canonicalMailbox at the wire boundary normalizes to "Starred" before
    // this ever runs, so a lowercase name here means something upstream lost
    // canonicalization — better to visibly waste a counter tick than to
    // silently skip a pivot write. Documenting the strict-equality convention.
    expect(decideMappedPivots(true, undefined, "starred")).toEqual([
      { mailbox: "Starred", present: true },
    ]);
  });
});
