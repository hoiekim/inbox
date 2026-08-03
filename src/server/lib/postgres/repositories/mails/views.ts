import { IS_SPAM, DRAFT } from "../../models";

/**
 * Which rows each IMAP mailbox contains, and which UID space it enumerates.
 *
 * Two kinds of mailbox reach this repository:
 *
 *  - **Mapped boxes** — the per-account views (`INBOX/accounts/<local-part>`,
 *    `Sent Messages/accounts/<local-part>`) and user-created boxes. Membership
 *    is a row in `mail_mailbox_uid`, which also carries the per-box UID.
 *  - **Domain views** — `INBOX`, the unified `Sent Messages`, and the utility
 *    views below. They hold no mapping rows: membership is a predicate over
 *    `mails`, and UIDs come from `mails.uid_domain`.
 *
 * The rules live here rather than in `imap.ts` so `counters.ts` can apply the
 * same branch without importing the module that imports it.
 *
 * The box names are duplicated from `imap/util.ts`, which cannot be imported
 * here: that module pulls from the `server` barrel, which re-exports this
 * repository. `views.test.ts` pins the two copies together.
 */

/** Prefix of the per-account received boxes (`INBOX/accounts/<local-part>`). */
const INBOX_ACCOUNTS_PREFIX = "INBOX/accounts/";

/**
 * Flag-derived views over the user's whole domain, mirroring folders the web
 * client already has. Each is one predicate over `mails` — no mapping rows, no
 * backfill — which is also why membership tracks the flag: a mail leaves
 * `Drafts` the moment `\Draft` is cleared, with nothing to keep in sync.
 */
export const DRAFTS_VIEW = "Drafts";
export const JUNK_VIEW = "Junk";

/**
 * A mailbox's membership rule as `column → required value`. One definition
 * renders both ways it is consumed: a SQL fragment for the hand-built IMAP
 * queries, and a filter bag for the `Table` call sites — so the two can't drift.
 */
export type MembershipFilter = Record<string, boolean>;

// A Map, not an object literal: mailbox names are user input, and `"toString"
// in {}` is true — an object lookup would hand a user-created box called
// `constructor` the domain UID space and show it the whole account.
const UTILITY_VIEW_MEMBERSHIP = new Map<string, MembershipFilter>([
  [DRAFTS_VIEW, { [DRAFT]: true }],
  [JUNK_VIEW, { [IS_SPAM]: true }],
]);

/** Whether `mailbox` names one of the flag-derived utility views. */
export const isUtilityView = (mailbox: string | null): boolean =>
  mailbox !== null && UTILITY_VIEW_MEMBERSHIP.has(mailbox);

/**
 * Whether a mailbox enumerates `mails.uid_domain` rather than joining
 * `mail_mailbox_uid`. True for the two unnamed domain views (`mailbox === null`)
 * and for the utility views, which carry a name only so their membership rule
 * can be looked up — they hold no mapping rows to join.
 */
export const usesDomainUidSpace = (mailbox: string | null): boolean =>
  mailbox === null || isUtilityView(mailbox);

/**
 * Whether a mailbox hides spam-classified and draft mail — true for the INBOX
 * tree only.
 *
 * INBOX (`mailbox === null`, `sent = false`) has no address condition at all,
 * and its per-account sub-views match purely on delivery address, so a
 * spam-classified or half-written mail lands in both simply by existing, showing
 * up intermixed with real mail and counting toward EXISTS/UNSEEN. Each now has a
 * view of its own (`Junk`, `Drafts`) — this is the other half of giving them
 * one home, and it matches where the web client already routes the same rows.
 *
 * Deliberately narrow on two axes:
 * - **Sent is never classified.** `is_spam` is only ever written on received
 *   mail, so the unified `Sent Messages` view and its sub-boxes are untouched.
 * - **User-created mailboxes keep their contents.** A mail the user COPYed into
 *   `Archive` is an explicit placement; the classifier does not get to hide it.
 *
 * Note this is not extended to `deleted`: `mails.deleted` is the IMAP
 * `\Deleted` flag, and RFC 3501 §6.4.3 requires `\Deleted` messages to stay in
 * the mailbox until EXPUNGE removes them. Soft-deleted mail leaving INBOX is a
 * `Trash` mailbox question (#725), not an INBOX predicate.
 */
export const quarantinesSpam = (mailbox: string | null, sent: boolean): boolean =>
  !sent && (mailbox === null || mailbox.startsWith(INBOX_ACCOUNTS_PREFIX));

/**
 * The rows a mailbox contains, on top of the scope (user, `sent`, `expunged`,
 * mapping join) its caller already applies. Empty for a box that filters
 * nothing.
 *
 * The utility views need no `sent` term of their own: `Drafts` and `Junk` both
 * resolve to `sent = false` through `isSentBox`, and every caller binds that.
 * A view spanning both directions (`Starred`, `Trash`) would need the `sent`
 * condition to move in here — see #725.
 */
export const membershipFilter = (
  mailbox: string | null,
  sent: boolean
): MembershipFilter => {
  const utility = mailbox !== null ? UTILITY_VIEW_MEMBERSHIP.get(mailbox) : undefined;
  if (utility) return utility;
  if (quarantinesSpam(mailbox, sent)) return { [IS_SPAM]: false, [DRAFT]: false };
  return {};
};

/**
 * The membership rule as a boolean expression. `TRUE` for a box that filters
 * nothing, so callers can interpolate it unconditionally. `prefix` qualifies the
 * columns for queries that alias `mails` (e.g. `"m."`).
 */
export const membershipExpression = (
  mailbox: string | null,
  sent: boolean,
  prefix: string = ""
): string => {
  const terms = Object.entries(membershipFilter(mailbox, sent)).map(
    ([column, value]) => `${prefix}${column} = ${value ? "TRUE" : "FALSE"}`
  );
  return terms.length > 0 ? terms.join(" AND ") : "TRUE";
};

/**
 * The same rule as a suffix for an existing `WHERE`, empty when the box filters
 * nothing so it appends cleanly to any clause.
 */
export const membershipCondition = (
  mailbox: string | null,
  sent: boolean,
  prefix: string = ""
): string => {
  const expression = membershipExpression(mailbox, sent, prefix);
  return expression === "TRUE" ? "" : ` AND ${expression}`;
};

/** Whether the box shows a strict subset of the rows its scope selects. */
export const filtersMembership = (mailbox: string | null, sent: boolean): boolean =>
  Object.keys(membershipFilter(mailbox, sent)).length > 0;
