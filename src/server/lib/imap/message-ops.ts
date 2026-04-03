/**
 * Message operations: FETCH, SEARCH, STORE, COPY, APPEND, EXPUNGE.
 */

import { MailType } from "common";
import { markRead, getDomainUidNext, getAccountUidNext } from "server";
import { logger } from "server";
import { Store } from "./store";
import { StoreOperationType } from "../postgres/repositories/mails";
import { boxToAccount } from "./util";
import { shouldMarkAsRead } from "./session-utils";
import {
  FetchRequest,
  SearchRequest,
  StoreRequest,
  CopyRequest,
  AppendRequest,
} from "./types";
import {
  buildFetchResponse,
  writeFetchResponse,
  getRequestedFields,
  convertSequenceSet,
} from "./fetch-helpers";
import {
  seqToUidNumber,
  uidToSeqNumber,
  countSequenceSetMessages,
  buildSequenceMapping,
  SequenceState,
} from "./sequence-resolver";

// ---------------------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------------------

export async function fetchMessagesTyped(
  tag: string,
  fetchRequest: FetchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const isFlagsOnly = fetchRequest.dataItems.every(
    (item) =>
      item.type === "FLAGS" ||
      item.type === "UID" ||
      item.type === "RFC822.SIZE" ||
      item.type === "INTERNALDATE"
  );
  const isHeaderOnly = fetchRequest.dataItems.every(
    (item) =>
      item.type === "FLAGS" ||
      item.type === "UID" ||
      item.type === "RFC822.SIZE" ||
      item.type === "INTERNALDATE" ||
      (item.type === "BODY" && item.section?.type === "HEADER") ||
      (item.type === "BODY" && item.section?.type === "HEADER_FIELDS")
  );
  const requestedCount = countSequenceSetMessages(
    seqState.seqToUid,
    fetchRequest.sequenceSet
  );
  const limit = isFlagsOnly ? Infinity : isHeaderOnly ? 500 : 50;
  if (requestedCount > limit) {
    write(`${tag} NO [LIMIT] FETCH too much data requested\r\n`);
    return;
  }

  try {
    const messages = await _fetchMessages(
      fetchRequest,
      isUidCommand,
      store,
      selectedMailbox,
      seqState
    );
    await _processFetchMessages(
      messages,
      fetchRequest,
      isUidCommand,
      store,
      selectedMailbox,
      seqState,
      write
    );
    write(`${tag} OK FETCH completed\r\n`);
  } catch (error) {
    logger.error("FETCH error", { component: "imap" }, error);
    write(`${tag} NO FETCH failed\r\n`);
  }
}

async function _fetchMessages(
  fetchRequest: FetchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState
): Promise<Map<string, Partial<MailType>>> {
  const ranges = convertSequenceSet(fetchRequest.sequenceSet);
  const requestedFields = getRequestedFields(fetchRequest.dataItems);
  const isUidFetch =
    fetchRequest.sequenceSet.type === "uid" || isUidCommand;

  const result = new Map<string, Partial<MailType>>();

  await Promise.all(
    ranges.map(async ({ start, end }) => {
      let uidStart = start;
      let uidEnd = end;

      if (!isUidFetch) {
        const startUid = seqToUidNumber(seqState.seqToUid, start);
        const endUid = seqToUidNumber(seqState.seqToUid, end);
        if (startUid === undefined || endUid === undefined) {
          logger.warn("Invalid sequence range", {
            component: "imap",
            start,
            end,
          });
          return;
        }
        uidStart = startUid;
        uidEnd = endUid;
      }

      const messages = await store.getMessages(
        selectedMailbox,
        uidStart,
        uidEnd,
        Array.from(requestedFields),
        true
      );
      messages.forEach((mail, id) => {
        result.set(id, mail);
      });
    })
  );

  return result;
}

async function _processFetchMessages(
  messages: Map<string, Partial<MailType>>,
  fetchRequest: FetchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const isDomainInbox = selectedMailbox === "INBOX";
  const isUidFetch =
    fetchRequest.sequenceSet.type === "uid" || isUidCommand;

  for (const [id, mail] of Array.from(messages.entries())) {
    const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
    const seqNum = uidToSeqNumber(seqState.seqToUid, seqState.uidToSeq, uid);

    if (seqNum === undefined) {
      logger.warn("No sequence number found for UID", {
        component: "imap",
        uid,
      });
      continue;
    }

    try {
      const response = await buildFetchResponse(
        mail,
        fetchRequest.dataItems,
        id,
        uid,
        isUidFetch,
        selectedMailbox
      );
      writeFetchResponse(write, seqNum, response);

      if (shouldMarkAsRead(fetchRequest.dataItems)) {
        await markRead(store.getUser().id, id);
      }
    } catch (error) {
      logger.error("Error processing message", { component: "imap", seqNum }, error);
    }
  }
}

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

export async function searchTyped(
  tag: string,
  searchRequest: SearchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  if (!searchRequest.criteria.length) {
    write(`${tag} BAD Search criteria is required\r\n`);
    return;
  }

  const hasUidCriteria = searchRequest.criteria.some((c) => c.type === "UID");
  if (!isUidCommand && hasUidCriteria) {
    write(`${tag} NO Not supported\r\n`);
    return;
  }

  try {
    const uids = await store.search(selectedMailbox, searchRequest.criteria);

    let result: number[];
    if (isUidCommand) {
      result = uids;
    } else {
      result = uids
        .map((uid) =>
          uidToSeqNumber(seqState.seqToUid, seqState.uidToSeq, uid)
        )
        .filter((seq): seq is number => seq !== undefined);
    }

    write(`* SEARCH ${result.join(" ")}\r\n`);
    write(`${tag} OK SEARCH completed\r\n`);
  } catch (error) {
    logger.error("Search failed", { component: "imap" }, error);
    write(`${tag} NO SEARCH failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

export async function storeFlagsTyped(
  tag: string,
  storeRequest: StoreRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  mailboxReadOnly: boolean,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  if (mailboxReadOnly) {
    write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
    return;
  }

  const isUidStore =
    storeRequest.sequenceSet.type === "uid" || isUidCommand;

  try {
    const { sequenceSet, operation, flags, silent } = storeRequest;
    const ranges = convertSequenceSet(sequenceSet);

    for (const { start, end } of ranges) {
      let uidStart = start;
      let uidEnd = end;

      if (!isUidStore) {
        const startUid = seqToUidNumber(seqState.seqToUid, start);
        const endUid = seqToUidNumber(seqState.seqToUid, end);
        if (startUid === undefined || endUid === undefined) {
          logger.warn("Invalid sequence range", {
            component: "imap",
            start,
            end,
          });
          continue;
        }
        uidStart = startUid;
        uidEnd = endUid;
      }

      const baseOperation = operation.replace(
        ".SILENT",
        ""
      ) as StoreOperationType;

      const updatedMails = await store.setFlags(
        selectedMailbox,
        uidStart,
        uidEnd,
        flags,
        true,
        baseOperation
      );

      if (updatedMails.length === 0) {
        write(`${tag} NO STORE failed\r\n`);
        throw new Error(
          `STORE failed for range ${start}-${end} in mailbox ${selectedMailbox}`
        );
      } else {
        if (!silent && !operation.includes("SILENT")) {
          for (const mail of updatedMails) {
            const seq = uidToSeqNumber(
              seqState.seqToUid,
              seqState.uidToSeq,
              mail.uid
            );
            if (seq !== undefined) {
              const currentFlags: string[] = [];
              if (mail.read) currentFlags.push("\\Seen");
              if (mail.saved) currentFlags.push("\\Flagged");
              if (mail.deleted) currentFlags.push("\\Deleted");
              if (mail.draft) currentFlags.push("\\Draft");
              if (mail.answered) currentFlags.push("\\Answered");

              write(
                `* ${seq} FETCH (FLAGS (${currentFlags.join(" ")}))\r\n`
              );
            }
          }
        }
      }
    }

    write(`${tag} OK STORE completed\r\n`);
  } catch (error) {
    logger.error("Error storing flags", { component: "imap" }, error);
    write(`${tag} NO STORE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// COPY
// ---------------------------------------------------------------------------

export async function copyMessageTyped(
  tag: string,
  _copyRequest: CopyRequest,
  _isUidCommand: boolean,
  write: (data: string) => boolean | undefined
): Promise<void> {
  write(`${tag} NO [CANNOT] COPY not permitted\r\n`);
}

// ---------------------------------------------------------------------------
// APPEND
// ---------------------------------------------------------------------------

export async function appendMessage(
  tag: string,
  appendRequest: AppendRequest,
  store: Store,
  selectedMailbox: string | null,
  write: (data: string) => boolean | undefined,
  onAppended: () => Promise<void>
): Promise<void> {
  try {
    const messageLines = appendRequest.message.split("\r\n");
    let headerEndIndex = messageLines.findIndex((line) => line === "");
    if (headerEndIndex === -1) headerEndIndex = messageLines.length;

    const headers = messageLines.slice(0, headerEndIndex).join("\r\n");
    const body = messageLines.slice(headerEndIndex + 1).join("\r\n");

    const subjectMatch = headers.match(/^Subject:\s*(.*)$/im);
    const fromMatch = headers.match(/^From:\s*(.*)$/im);
    const toMatch = headers.match(/^To:\s*(.*)$/im);
    const dateMatch = headers.match(/^Date:\s*(.*)$/im);
    const messageIdMatch = headers.match(/^Message-ID:\s*(.*)$/im);

    const mail = new (await import("common")).Mail();

    mail.subject = subjectMatch ? subjectMatch[1].trim() : "";
    mail.text = body;
    mail.html = body.includes("<") ? body : "";
    mail.date = dateMatch
      ? new Date(dateMatch[1]).toISOString()
      : new Date().toISOString();
    mail.messageId = messageIdMatch
      ? messageIdMatch[1].trim().replace(/[<>]/g, "")
      : mail.messageId;

    mail.draft = appendRequest.flags?.includes("\\Draft") ?? true;
    mail.read = appendRequest.flags?.includes("\\Seen") || false;
    mail.saved = appendRequest.flags?.includes("\\Flagged") || false;
    mail.deleted = appendRequest.flags?.includes("\\Deleted") || false;
    mail.answered = appendRequest.flags?.includes("\\Answered") || false;

    if (fromMatch) {
      mail.from = {
        value: [{ address: fromMatch[1].trim(), name: "" }],
        text: fromMatch[1].trim(),
      };
    }
    if (toMatch) {
      mail.to = {
        value: [{ address: toMatch[1].trim(), name: "" }],
        text: toMatch[1].trim(),
      };
    }

    const user = store.getUser();
    const account = boxToAccount(user.username, appendRequest.mailbox);
    const domainUid = await getDomainUidNext(user.id);
    const accountUid = await getAccountUidNext(user.id, account);
    mail.uid.domain = domainUid || 1;
    mail.uid.account = accountUid || 1;

    const result = await store.storeMail(mail);

    let uid: number;
    if (appendRequest.mailbox === "INBOX") uid = mail.uid.domain;
    else uid = mail.uid.account;

    if (result) {
      if (selectedMailbox === appendRequest.mailbox) {
        await onAppended();
      }
      write(
        `${tag} OK [APPENDUID ${Date.now()} ${uid}] APPEND completed\r\n`
      );
    } else {
      write(`${tag} NO APPEND failed to store message\r\n`);
    }
  } catch (error) {
    logger.error("APPEND error", { component: "imap" }, error);
    write(`${tag} NO APPEND failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// EXPUNGE
// ---------------------------------------------------------------------------

export async function expunge(
  tag: string,
  store: Store,
  selectedMailbox: string,
  mailboxReadOnly: boolean,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  if (mailboxReadOnly) {
    write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
    return;
  }

  try {
    const expungedUids = await store.expunge(selectedMailbox);

    const seqNumbers: number[] = [];
    for (const uid of expungedUids) {
      const seq = uidToSeqNumber(seqState.seqToUid, seqState.uidToSeq, uid);
      if (seq !== undefined) {
        seqNumbers.push(seq);
      }
    }

    seqNumbers.sort((a, b) => b - a);

    for (const seq of seqNumbers) {
      write(`* ${seq} EXPUNGE\r\n`);
    }

    await buildSequenceMapping(store, selectedMailbox, seqState);

    write(`${tag} OK EXPUNGE completed\r\n`);
  } catch (error) {
    logger.error("Expunge failed", { component: "imap" }, error);
    write(`${tag} NO EXPUNGE failed\r\n`);
  }
}
