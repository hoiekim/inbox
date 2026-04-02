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
  isSentMessagesAccountsFolder,
  SENT_MESSAGES_ACCOUNTS_FOLDER,
  SENT_MESSAGES_FOLDER,
} from "./util";
import { Store } from "./store";
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
  mailbox: string,
  items: StatusItem[],
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
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

export function getMailboxAttributes(box: string, allBoxes: string[]): string {
  if (isAccountsFolder(box)) {
    return "\\HasChildren \\Noselect";
  }
  if (isSentMessagesAccountsFolder(box)) {
    return "\\HasChildren \\Noselect";
  }
  if (box === SENT_MESSAGES_FOLDER) {
    const hasSentAccountChildren = allBoxes.some((b) =>
      b.startsWith(`${SENT_MESSAGES_ACCOUNTS_FOLDER}/`)
    );
    return hasSentAccountChildren ? "\\HasChildren" : "\\HasNoChildren";
  }
  return "\\HasNoChildren";
}

export async function listMailboxes(
  tag: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    const boxes = await store.listMailboxes();
    boxes.forEach((box) => {
      const attrs = getMailboxAttributes(box, boxes);
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
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    const boxes = await store.listMailboxes();
    boxes.forEach((box) => {
      const attrs = getMailboxAttributes(box, boxes);
      write(`* LSUB (${attrs}) "/" "${box}"\r\n`);
    });
    write(`${tag} OK LSUB completed\r\n`);
  } catch (error) {
    logger.error("Error listing subscribed mailboxes", { component: "imap" }, error);
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
  const cleanName = name.replace(/^"(.*)"$/, "$1");

  if (!cleanName) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }

  if (isAccountsFolder(cleanName)) {
    write(`${tag} NO [CANNOT] ${ACCOUNTS_FOLDER} is not selectable\r\n`);
    return;
  }

  if (isSentMessagesAccountsFolder(cleanName)) {
    write(`${tag} NO [CANNOT] ${SENT_MESSAGES_ACCOUNTS_FOLDER} is not selectable\r\n`);
    return;
  }

  try {
    setSelected(cleanName, 0);

    await buildSequenceMapping(store, cleanName, seqState);

    const countResult = await store.countMessages(cleanName);

    if (countResult === null) {
      setSelected(null, 0);
      clearSeqState();
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const { total, unread } = countResult;
    setSelected(cleanName, total);

    const uidValidity = await getImapUidValidity(store.getUser().id);

    write(`* ${total} EXISTS\r\n`);
    write(`* 0 RECENT\r\n`);
    write(`* OK [UNSEEN ${unread}] Message ${unread} is first unseen\r\n`);
    const uidNext =
      seqState.seqToUid.length > 0
        ? seqState.seqToUid[seqState.seqToUid.length - 1] + 1
        : countResult.maxUid + 1 || 1;
    write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
    write(`* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`);
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
