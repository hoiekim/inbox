/**
 * Which rows each mailbox contains (#725).
 *
 * The utility views are defined twice by necessity — once here in the
 * repository (the predicate) and once in `imap/util.ts` (the LIST attribute and
 * the write-side placement flag), because the IMAP module pulls from the
 * `server` barrel that re-exports this repository. The last describe block is
 * the guard that keeps the two copies saying the same thing.
 */

import { describe, it, expect } from "bun:test";
import {
  DRAFTS_VIEW,
  JUNK_VIEW,
  filtersMembership,
  isUtilityView,
  membershipCondition,
  membershipExpression,
  membershipFilter,
  usesDomainUidSpace,
} from "./views";

describe("utility views", () => {
  it("select their rows by flag", () => {
    expect(membershipExpression(DRAFTS_VIEW, false)).toBe("draft = TRUE");
    expect(membershipExpression(JUNK_VIEW, false)).toBe("is_spam = TRUE");
    expect(membershipCondition(DRAFTS_VIEW, false)).toBe(" AND draft = TRUE");
    expect(membershipCondition(JUNK_VIEW, false)).toBe(" AND is_spam = TRUE");
  });

  it("qualify the column with the caller's alias", () => {
    expect(membershipExpression(DRAFTS_VIEW, false, "m.")).toBe("m.draft = TRUE");
    expect(membershipCondition(JUNK_VIEW, false, "m.")).toBe(" AND m.is_spam = TRUE");
  });

  it("read the domain UID space — they hold no mapping rows to join", () => {
    // The whole point of naming them: a utility view reaches the repository as a
    // string (so its predicate can be looked up) but must still take the
    // `uid_domain` branch. Routing it to the JOIN would match zero mapping rows
    // and report a permanently empty mailbox.
    expect(usesDomainUidSpace(DRAFTS_VIEW)).toBe(true);
    expect(usesDomainUidSpace(JUNK_VIEW)).toBe(true);
    expect(usesDomainUidSpace(null)).toBe(true);
    expect(usesDomainUidSpace("INBOX/accounts/alice")).toBe(false);
    expect(usesDomainUidSpace("Archive")).toBe(false);
  });

  it("are matched exactly, not by prefix", () => {
    // A user-created `Drafts2` is an ordinary mapped box; treating it as a view
    // would hand it INBOX's UID space and hide every mail it actually holds.
    expect(isUtilityView("Drafts2")).toBe(false);
    expect(isUtilityView("INBOX/Drafts")).toBe(false);
    expect(isUtilityView(null)).toBe(false);
    expect(usesDomainUidSpace("Drafts2")).toBe(false);
  });

  it("do not inherit a prototype key as a view name", () => {
    // The lookup is a plain object index, so a name like `constructor` must not
    // resolve to a predicate and silently take the domain branch.
    expect(isUtilityView("constructor")).toBe(false);
    expect(isUtilityView("toString")).toBe(false);
    expect(membershipExpression("constructor", false)).toBe("TRUE");
  });
});

describe("INBOX", () => {
  it("hides spam and drafts — each has a view of its own", () => {
    expect(membershipExpression(null, false)).toBe(
      "is_spam = FALSE AND draft = FALSE"
    );
    expect(membershipExpression("INBOX/accounts/alice", false, "m.")).toBe(
      "m.is_spam = FALSE AND m.draft = FALSE"
    );
  });

  it("does not exclude \\Deleted mail", () => {
    // `mails.deleted` is the IMAP \Deleted flag; RFC 3501 §6.4.3 keeps those
    // messages in the mailbox until EXPUNGE. Assert on what the rule emits
    // rather than on the absence of a string, which would pass just as well on
    // a rule that never had one.
    expect(Object.keys(membershipFilter(null, false))).toEqual([
      "is_spam",
      "draft",
    ]);
  });

  it("leaves sent mail and user-created boxes unfiltered", () => {
    expect(membershipExpression(null, true)).toBe("TRUE");
    expect(membershipExpression("Sent Messages/accounts/alice", true)).toBe("TRUE");
    expect(membershipExpression("Archive", false)).toBe("TRUE");
    expect(membershipCondition("Archive", false)).toBe("");
    expect(filtersMembership("Archive", false)).toBe(false);
    expect(filtersMembership(null, false)).toBe(true);
    expect(filtersMembership(DRAFTS_VIEW, false)).toBe(true);
  });
});

describe("the IMAP-side folder table agrees with the predicate", () => {
  it("names the same boxes", async () => {
    const { UTILITY_FOLDERS } = await import("../../../imap/util");
    expect(UTILITY_FOLDERS.map((folder) => folder.name).sort()).toEqual(
      [DRAFTS_VIEW, JUNK_VIEW].sort()
    );
  });

  it("writes exactly the flags the view reads", async () => {
    // A COPY / MOVE / APPEND into a utility folder sets `placement`; the view
    // selects on `membershipFilter`. If they ever disagree, the write reports
    // success and the message is invisible in the box the client named.
    const { UTILITY_FOLDERS } = await import("../../../imap/util");
    for (const { name, placement } of UTILITY_FOLDERS) {
      expect(placement, `no placement for ${name}`).toEqual(
        membershipFilter(name, false)
      );
    }
  });

  it("is listed as domain-scoped on the IMAP side too", async () => {
    // `isDomainScoped` drives which UID the wire reports (COPYUID / APPENDUID /
    // FETCH); it has to agree with `usesDomainUidSpace`, which drives which UID
    // the query selects. Disagreement emits a UID that addresses nothing.
    const { isDomainScoped } = await import("../../../imap/util");
    for (const view of [DRAFTS_VIEW, JUNK_VIEW]) {
      expect(isDomainScoped(view)).toBe(usesDomainUidSpace(view));
    }
  });
});
