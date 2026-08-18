/**
 * Mailbox management operations.
 *
 * Free functions for CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE,
 * STATUS, LIST, LSUB, and SELECT/EXAMINE.
 */

import {
  createMailbox as dbCreateMailbox,
  deleteMailboxByName,
  renameMailbox as dbRenameMailbox,
  setMailboxSubscribed,
  getImapUidValidity,
} from "server";
import { logger } from "server";
import {
  ACCOUNTS_FOLDER,
  isAccountsFolder,
  isInbox,
  isSentMessagesAccountsFolder,
  isUtilityFolder,
  utilityFolder,
  canonicalMailbox,
  SENT_MESSAGES_ACCOUNTS_FOLDER,
} from "./util";
import { MailboxEntry, Store } from "./store";
import { StatusItem } from "./types";
import {
  buildSequenceMapping,
  SequenceState,
} from "./sequence-resolver";

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

export async function createMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  if (!cleanName) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }
  // RFC 3501 §6.3.3: "It is an error to attempt to create INBOX or a
  // mailbox with a name that refers to an existent mailbox." INBOX always
  // exists as a synthetic mailbox — any casing of the name refers to it.
  // Without this guard, the DB would accept the INSERT (no row named
  // "inbox" exists) and leave a phantom user-mailbox row that's de-duped
  // out of LIST but lingers in the table.
  if (isInbox(cleanName) || isUtilityFolder(cleanName)) {
    write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
    return;
  }
  try {
    const userId = store.getUser().id;
    const created = await dbCreateMailbox({ user_id: userId, name: cleanName });
    if (!created) {
      write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
      return;
    }
    logger.info("Mailbox created", { component: "imap", mailbox: cleanName });
    write(`${tag} OK CREATE completed\r\n`);
  } catch (error) {
    logger.error("Error creating mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} NO CREATE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function deleteMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  if (!cleanName) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }
  // RFC 3501 §6.3.4: deletion of INBOX is forbidden. Short-circuit on every
  // casing — without this guard, `deleteMailboxByName` would return
  // "not_found" (no DB row matches lowercase 'inbox') and the client would
  // get a misleading "does not exist" instead of the correct refusal.
  if (isInbox(cleanName)) {
    write(`${tag} NO [CANNOT] Cannot delete INBOX\r\n`);
    return;
  }
  // Same reason INBOX is refused: a utility folder is a server-defined view
  // with no row behind it, so `deleteMailboxByName` would report "does not
  // exist" for a box the client can see in LIST.
  if (isUtilityFolder(cleanName)) {
    write(`${tag} NO [CANNOT] Cannot delete system mailbox\r\n`);
    return;
  }
  try {
    const userId = store.getUser().id;
    const result = await deleteMailboxByName(userId, cleanName);
    if (result === "not_found") {
      write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
      return;
    }
    if (result === "protected") {
      write(`${tag} NO [CANNOT] Cannot delete system mailbox\r\n`);
      return;
    }
    logger.info("Mailbox deleted", { component: "imap", mailbox: cleanName });
    write(`${tag} OK DELETE completed\r\n`);
  } catch (error) {
    logger.error("Error deleting mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} NO DELETE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// RENAME
// ---------------------------------------------------------------------------

export async function renameMailbox(
  tag: string,
  oldName: string,
  newName: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanOld = oldName.replace(/^"(.*)"$/, "$1");
  const cleanNew = newName.replace(/^"(.*)"$/, "$1");
  if (!cleanOld || !cleanNew) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }
  // RFC 3501 §6.3.5 defines special RENAME-INBOX semantics (move all
  // messages to the new name, leave INBOX empty). The current backing
  // implementation doesn't support that, so guard explicitly rather than
  // returning the misleading "[NONEXISTENT] Mailbox does not exist" the
  // DB layer would otherwise produce for any casing of `inbox` (no DB
  // row → not_found). Filed as a follow-up if the workflow needs it.
  if (isInbox(cleanOld)) {
    write(`${tag} NO [CANNOT] RENAME INBOX is not supported\r\n`);
    return;
  }
  if (isUtilityFolder(cleanOld)) {
    write(`${tag} NO [CANNOT] Cannot rename system mailbox\r\n`);
    return;
  }
  // Target must not collide with a synthetic mailbox either.
  if (isInbox(cleanNew) || isUtilityFolder(cleanNew)) {
    write(`${tag} NO [ALREADYEXISTS] Target mailbox already exists\r\n`);
    return;
  }
  try {
    const userId = store.getUser().id;
    const result = await dbRenameMailbox(userId, cleanOld, cleanNew);
    if (result === "not_found") {
      write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
      return;
    }
    if (result === "protected") {
      write(`${tag} NO [CANNOT] Cannot rename system mailbox\r\n`);
      return;
    }
    if (result === "name_taken") {
      write(`${tag} NO [ALREADYEXISTS] Target mailbox already exists\r\n`);
      return;
    }
    logger.info("Mailbox renamed", { component: "imap", from: cleanOld, to: cleanNew });
    write(`${tag} OK RENAME completed\r\n`);
  } catch (error) {
    logger.error("Error renaming mailbox", { component: "imap" }, error);
    write(`${tag} NO RENAME failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// SUBSCRIBE / UNSUBSCRIBE
// ---------------------------------------------------------------------------

export async function subscribeMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  try {
    const userId = store.getUser().id;
    await setMailboxSubscribed(userId, cleanName, true);
    write(`${tag} OK SUBSCRIBE completed\r\n`);
  } catch (error) {
    logger.error("Error subscribing mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} OK SUBSCRIBE completed\r\n`);
  }
}

export async function unsubscribeMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  try {
    const userId = store.getUser().id;
    await setMailboxSubscribed(userId, cleanName, false);
    write(`${tag} OK UNSUBSCRIBE completed\r\n`);
  } catch (error) {
    logger.error("Error unsubscribing mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} OK UNSUBSCRIBE completed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

export async function statusMailbox(
  tag: string,
  mailboxArg: string,
  items: StatusItem[],
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  // RFC 3501 §5.1: INBOX is case-insensitive. Canonicalize so downstream
  // responses (* STATUS "INBOX" ...) echo the canonical name regardless of
  // the casing the client used.
  const mailbox = canonicalMailbox(mailboxArg);
  try {
    if (!(await store.mailboxExists(mailbox))) {
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const countResult = await store.countMessages(mailbox);

    if (countResult === null) {
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const { total, unread } = countResult;

    let uidValidity: number | null = null;
    if (items.includes("UIDVALIDITY")) {
      uidValidity = await getImapUidValidity(store.getUser().id);
    }

    // RFC 4551 §3.1.2: STATUS may request HIGHESTMODSEQ. Resolve it once here
    // (a single MAX(modseq) query) rather than per-item inside the loop.
    let highestModseq: number | null = null;
    if (items.includes("HIGHESTMODSEQ")) {
      highestModseq = await store.getHighestModseq(mailbox);
    }

    const statusItems: string[] = [];
    items.forEach((item) => {
      switch (item) {
        case "MESSAGES":
          statusItems.push("MESSAGES", total.toString());
          break;
        case "UIDNEXT":
          statusItems.push("UIDNEXT", (countResult.maxUid + 1).toString());
          break;
        case "UIDVALIDITY":
          statusItems.push("UIDVALIDITY", uidValidity!.toString());
          break;
        case "UNSEEN":
          statusItems.push("UNSEEN", unread.toString());
          break;
        case "RECENT":
          statusItems.push("RECENT", "0");
          break;
        case "HIGHESTMODSEQ":
          statusItems.push("HIGHESTMODSEQ", highestModseq!.toString());
          break;
      }
    });

    write(`* STATUS "${mailbox}" (${statusItems.join(" ")})\r\n`);
    write(`${tag} OK STATUS completed\r\n`);
  } catch (error) {
    logger.error("Error getting mailbox status", { component: "imap", mailbox }, error);
    write(`${tag} NO STATUS failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// LIST / LSUB helpers
// ---------------------------------------------------------------------------

/**
/**
 * A mailbox path under the spelling LIST/LSUB reason about, as opposed to the
 * one they emit. `canonicalMailbox` folds only whole names, so apply it to the
 * leading segment: CREATE accepts `inbox/foo`, the listable set carries that
 * verbatim, and the row it descends from is listed as `INBOX`. Every path
 * comparison — ancestry, the \HasChildren lookup, and the reference+pattern
 * match — has to agree on one spelling or the response contradicts itself.
 */
const canonicalPath = (box: string): string => {
  const delimiter = box.indexOf("/");
  if (delimiter === -1) return canonicalMailbox(box);
  return canonicalMailbox(box.slice(0, delimiter)) + box.slice(delimiter);
};

/**
 * Every proper ancestor path of the given names — `Projects/Work/Q3`
 * contributes `Projects` and `Projects/Work`. Built in one pass
 * (O(names × depth)) rather than re-scanning the set per candidate, which
 * would be quadratic on an account with thousands of per-address boxes, and
 * keyed on path segments so a `Project` that is merely a string prefix of
 * `Projects/Work` is not treated as its parent.
 */
export const collectAncestors = (names: string[]): Set<string> => {
  const ancestors = new Set<string>();
  names.forEach((name) => {
    const parts = canonicalPath(name).split("/");
    for (let i = 1; i < parts.length; i++) {
      ancestors.add(parts.slice(0, i).join("/"));
    }
  });
  return ancestors;
};

/**
 * Attributes for one LIST/LSUB row. `parentPaths` is the ancestor set of the
 * whole listable mailbox set — build it once per command with
 * `collectAncestors`, never per row, or the response goes quadratic on an
 * account carrying thousands of per-address boxes.
 *
 * ```ts
 * const parentPaths = collectAncestors(boxes);
 * boxes.forEach((box) => write(`* LIST (${getMailboxAttributes(box, parentPaths)}) …`));
 * ```
 */
export function getMailboxAttributes(box: string, parentPaths: ReadonlySet<string>): string {
  // RFC 5258 §3: \HasChildren / \HasNoChildren is what a client keys its
  // expand affordance off, so it has to follow the names actually listed.
  const hierarchy = parentPaths.has(canonicalPath(box)) ? "\\HasChildren" : "\\HasNoChildren";
  // RFC 6154 §2: the special-use attribute travels alongside the ordinary ones
  // in a plain LIST response, which is how a client maps a role to a box name
  // without guessing at the name.
  const utility = utilityFolder(box);
  if (utility) {
    return `${utility.specialUse} ${hierarchy}`;
  }
  if (isAccountsFolder(box) || isSentMessagesAccountsFolder(box)) {
    return `${hierarchy} \\Noselect`;
  }
  return hierarchy;
}

/**
 * Match a mailbox name against an IMAP LIST reference + pattern (RFC 3501
 * §6.3.8). The reference and pattern are concatenated; within the result "*"
 * matches across the "/" hierarchy delimiter while "%" matches only within a
 * single level. Every other character matches literally.
 */
export function matchesListPattern(
  reference: string,
  pattern: string,
  box: string
): boolean {
  const combined = reference + pattern;
  let regex = "^";
  for (const char of combined) {
    if (char === "*") {
      regex += ".*";
    } else if (char === "%") {
      regex += "[^/]*";
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  // RFC 3501 §5.1: INBOX is matched case-insensitively. This applies to
  // LIST/LSUB patterns too — `LIST "" "inbox"` must surface the canonical
  // INBOX row. Apply the `i` regex flag ONLY when the target box is
  // INBOX, so every other mailbox name stays strictly case-sensitive
  // (Archive ≠ archive, per the RFC).
  const flags = isInbox(box) ? "i" : "";
  return new RegExp(regex, flags).test(box);
}

export async function listMailboxes(
  tag: string,
  reference: string,
  pattern: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    // An empty pattern is a special request for the hierarchy delimiter and the
    // root name of the reference (RFC 3501 §6.3.8); no mailboxes are returned.
    if (pattern === "") {
      write(`* LIST (\\Noselect) "/" "${reference}"\r\n`);
      write(`${tag} OK LIST completed\r\n`);
      return;
    }
    const boxes = await store.listMailboxes();
    // Ancestors come from the unfiltered set: a child the pattern excludes
    // still makes its parent \HasChildren.
    const parentPaths = collectAncestors(boxes);
    boxes
      .filter((box) => matchesListPattern(reference, pattern, canonicalPath(box)))
      .forEach((box) => {
        const attrs = getMailboxAttributes(box, parentPaths);
        write(`* LIST (${attrs}) "/" "${box}"\r\n`);
      });
    write(`${tag} OK LIST completed\r\n`);
  } catch (error) {
    logger.error("Error listing mailboxes", { component: "imap" }, error);
    write(`${tag} NO LIST failed\r\n`);
  }
}

export async function listSubscribedMailboxes(
  tag: string,
  reference: string,
  pattern: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    if (pattern === "") {
      write(`* LSUB (\\Noselect) "/" "${reference}"\r\n`);
      write(`${tag} OK LSUB completed\r\n`);
      return;
    }
    const entries = await store.listMailboxEntries();
    // Hierarchy is a property of the full listable set, not of the subscribed
    // subset, so filtering a child out of the response cannot change what its
    // parent reports.
    const allBoxes = entries.map((entry) => entry.name);
    const parentPaths = collectAncestors(allBoxes);

    const promoteAncestors = (reference + pattern).includes("%");
    const ancestorsOfSubscribed = promoteAncestors
      ? collectAncestors(entries.filter((entry) => entry.subscribed).map((e) => e.name))
      : new Set<string>();

    // An ancestor need not exist as a mailbox of its own. Nothing here creates
    // the superior names on CREATE (RFC 3501 §6.3.3 only says SHOULD), so
    // `Projects/Work` can be subscribed with no `Projects` row at all — and
    // §6.3.9's own example is precisely such a name, which is why the rule
    // marks it \Noselect rather than assuming it is selectable.
    const listed = new Set(allBoxes);
    const synthesized: MailboxEntry[] = [...ancestorsOfSubscribed]
      .filter((name) => !listed.has(name))
      .sort()
      .map((name) => ({ name, subscribed: false }));

    [...entries, ...synthesized]
      .filter((entry) => entry.subscribed || ancestorsOfSubscribed.has(entry.name))
      .filter((entry) => matchesListPattern(reference, pattern, canonicalPath(entry.name)))
      .forEach((entry) => {
        // An unsubscribed name is in this response only because it has a
        // subscribed descendant, hence \HasChildren unconditionally.
        const attrs = entry.subscribed
          ? getMailboxAttributes(entry.name, parentPaths)
          : "\\HasChildren \\Noselect";
        write(`* LSUB (${attrs}) "/" "${entry.name}"\r\n`);
      });
    write(`${tag} OK LSUB completed\r\n`);
  } catch (error) {
    logger.error("Error listing subscribed mailboxes", { component: "imap.lsub" }, error);
    write(`${tag} NO LSUB failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// SELECT / EXAMINE
// ---------------------------------------------------------------------------

export interface SelectResult {
  selectedMailbox: string;
  selectedMailboxMessageCount: number;
}

export async function selectMailbox(
  tag: string,
  name: string,
  readOnly: boolean,
  store: Store,
  write: (data: string) => boolean | undefined,
  seqState: SequenceState,
  setSelected: (mailbox: string | null, count: number) => void,
  clearSeqState: () => void
): Promise<void> {
  const unquoted = name.replace(/^"(.*)"$/, "$1");

  if (!unquoted) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }

  // RFC 3501 §5.1: INBOX is case-insensitive. Canonicalize so the selected
  // mailbox stored on the session and every downstream response (`* OK
  // [READ-WRITE]`, EXISTS/RECENT, FETCH responses) reflect "INBOX" rather
  // than whatever casing the client sent.
  const cleanName = canonicalMailbox(unquoted);

  if (isAccountsFolder(cleanName)) {
    write(`${tag} NO [CANNOT] ${ACCOUNTS_FOLDER} is not selectable\r\n`);
    return;
  }

  if (isSentMessagesAccountsFolder(cleanName)) {
    write(`${tag} NO [CANNOT] ${SENT_MESSAGES_ACCOUNTS_FOLDER} is not selectable\r\n`);
    return;
  }

  try {
    if (!(await store.mailboxExists(cleanName))) {
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    setSelected(cleanName, 0);

    await buildSequenceMapping(store, cleanName, seqState);

    const countResult = await store.countMessages(cleanName);

    if (countResult === null) {
      setSelected(null, 0);
      clearSeqState();
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const { total } = countResult;
    setSelected(cleanName, total);

    const uidValidity = await getImapUidValidity(store.getUser().id);

    // [UNSEEN <n>] is the sequence number of the first unseen message, not the
    // unread count (RFC 3501 §7.1). Map the lowest-UID unread message to its
    // 1-based sequence position; omit the response code entirely when all read.
    const firstUnseenUid = await store.getFirstUnseenUid(cleanName);
    const firstUnseenSeq =
      firstUnseenUid !== null ? seqState.uidToSeq.get(firstUnseenUid) : undefined;

    write(`* ${total} EXISTS\r\n`);
    write(`* 0 RECENT\r\n`);
    if (firstUnseenSeq) {
      write(`* OK [UNSEEN ${firstUnseenSeq}] Message ${firstUnseenSeq} is first unseen\r\n`);
    }
    // UIDNEXT comes from the mailbox's highest assigned UID, never from the
    // last entry of `seqToUid`. The two diverge whenever the mailbox hides a
    // message it still holds a UID for — INBOX's spam quarantine is one such
    // case — and taking the visible tail would let UIDNEXT decrease (RFC 3501
    // §2.3.1.1 forbids it) and disagree with the value STATUS reports off the
    // same unfiltered `maxUid`.
    const uidNext = countResult.maxUid + 1 || 1;
    write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
    write(`* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`);
    // RFC 4551 §3.1.1: a CONDSTORE-capable server reports the mailbox's
    // HIGHESTMODSEQ on SELECT/EXAMINE so the client can detect changes since
    // its last-known mod-sequence without a full resync.
    const highestModseq = await store.getHighestModseq(cleanName);
    write(`* OK [HIGHESTMODSEQ ${highestModseq}] Highest mod-sequence\r\n`);
    write(`* FLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered)\r\n`);
    write(
      `* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered \\*)] Flags permitted\r\n`
    );
    const mode = readOnly ? "READ-ONLY" : "READ-WRITE";
    const command = readOnly ? "EXAMINE" : "SELECT";
    write(`${tag} OK [${mode}] ${command} completed\r\n`);
  } catch (error) {
    logger.error("Error selecting mailbox", { component: "imap", name }, error);
    write(`${tag} NO SELECT failed\r\n`);
  }
}
