/**
 * Message operations: FETCH, SEARCH, STORE, COPY, APPEND, EXPUNGE.
 */

import { MailType } from "common";
import {
  markRead,
  getDomainUidNext,
  getAccountUidNext,
  getImapUidValidity,
} from "server";
import { logger } from "server";
import { Store } from "./store";
import { StoreOperationType } from "../postgres/repositories/mails";
import { boxToAccount, isInbox, isSentBox } from "./util";
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
  resolveSeqRangeToUids,
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
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) {
          logger.warn("Sequence range matched no messages", {
            component: "imap",
            start,
            end,
          });
          return;
        }
        uidStart = resolved.uidStart;
        uidEnd = resolved.uidEnd;
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
  const isDomainInbox = isInbox(selectedMailbox);
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
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) {
          logger.warn("Sequence range matched no messages", {
            component: "imap",
            start,
            end,
          });
          continue;
        }
        uidStart = resolved.uidStart;
        uidEnd = resolved.uidEnd;
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

      // RFC 3501 §6.4.6: STORE on a UID/sequence range that matches no
      // messages is NOT an error — the server simply emits zero untagged
      // FETCH responses and the command still completes OK. The old code
      // wrote a tagged NO here and then threw, which (a) violated the RFC by
      // failing a valid command and (b) caused the catch block below to write
      // a SECOND tagged NO — two tagged responses for one command, which
      // desynchronizes the client. Skip empty ranges instead.
      if (updatedMails.length === 0) {
        continue;
      }

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

            const uidItem = isUidStore ? `UID ${mail.uid} ` : "";
            write(
              `* ${seq} FETCH (${uidItem}FLAGS (${currentFlags.join(" ")}))\r\n`
            );
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
// COPY (RFC 3501 §6.4.7 + RFC 4315 COPYUID)
// ---------------------------------------------------------------------------

/**
 * Helper: explicit UID list for a [start, end] range.
 */
const expandRange = (start: number, end: number): number[] => {
  const out: number[] = [];
  for (let n = start; n <= end; n++) out.push(n);
  return out;
};

/**
 * Compact a sorted UID list to the RFC 3501 sequence-set form ("1,3:5,7").
 * Per RFC 4315, the COPYUID response uses the same sequence-set syntax.
 */
const formatUidSet = (uids: number[]): string => {
  if (uids.length === 0) return "";
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}:${rangeEnd}`);
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }
  parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}:${rangeEnd}`);
  return parts.join(",");
};

export async function copyMessageTyped(
  tag: string,
  copyRequest: CopyRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    // Canonicalize destination per RFC 3501 §5.1 (INBOX case-insensitive).
    const destMailbox = isInbox(copyRequest.mailbox) ? "INBOX" : copyRequest.mailbox;

    // RFC 4315 §2.1: destination must exist; otherwise NO [TRYCREATE].
    if (!(await store.mailboxExists(destMailbox))) {
      write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      return;
    }

    // RFC 3501 §6.4.7: COPY source must use the selected mailbox's UID/seq
    // space. `isUidCopy` reflects whether the protocol entry was UID COPY
    // (operating on UIDs directly) or COPY (operating on sequence numbers).
    const isUidCopy =
      copyRequest.sequenceSet.type === "uid" || isUidCommand;
    const ranges = convertSequenceSet(copyRequest.sequenceSet);

    // Resolve each range to a concrete UID list. Sequence-number ranges
    // map through seqState; UID ranges pass through as-is.
    const uidRanges: Array<{ uidStart: number; uidEnd: number }> = [];
    for (const { start, end } of ranges) {
      if (isUidCopy) {
        uidRanges.push({ uidStart: start, uidEnd: end });
      } else {
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) continue;
        uidRanges.push({ uidStart: resolved.uidStart, uidEnd: resolved.uidEnd });
      }
    }

    if (uidRanges.length === 0) {
      // Nothing to copy (every range resolved to no messages). RFC says
      // OK with no COPYUID is fine.
      write(`${tag} OK COPY completed\r\n`);
      return;
    }

    // The full set of fields we need to clone — anything the FETCH/render
    // pipeline might surface to a client of the destination mailbox.
    const cloneFields = [
      "subject",
      "date",
      "html",
      "text",
      "from",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "envelopeFrom",
      "envelopeTo",
      "attachments",
      "messageId",
      "insight",
      "flags",
      "uid",
    ];

    // Pull the source mails. `getMessages` queries by the selected
    // mailbox's UID space, so the source UIDs are interpreted correctly.
    const sourceMails: Array<Partial<MailType>> = [];
    for (const { uidStart, uidEnd } of uidRanges) {
      const batch = await store.getMessages(
        selectedMailbox,
        uidStart,
        uidEnd,
        cloneFields,
        true
      );
      // Preserve UID order (Map preserves insertion order from the SQL
      // query; downstream we sort by source UID for the COPYUID response).
      batch.forEach((mail) => sourceMails.push(mail));
    }

    if (sourceMails.length === 0) {
      // Range pointed at deleted/unknown UIDs. RFC 4315 says: still OK,
      // no COPYUID required when no messages were actually copied.
      write(`${tag} OK COPY completed\r\n`);
      return;
    }

    const user = store.getUser();
    // The destination's address routing. For INBOX, `accountName` is null
    // in `resolveBox` (the mail's existing to_address keeps it in INBOX
    // anyway). For accounts/<name>, "Sent Messages/accounts/<name>", and
    // user-created mailboxes (e.g. "Archive"), `boxToAccount` returns the
    // synthetic address that drives the destination-mailbox query
    // (e.g. "Archive@<domain>").
    const destAccount = boxToAccount(user.username, destMailbox);
    const destIsInbox = isInbox(destMailbox);
    const destIsSent = isSentBox(destMailbox);

    // Source-side UID extraction for the COPYUID response.
    const sourceIsInbox = isInbox(selectedMailbox);
    const srcUidOf = (mail: Partial<MailType>): number =>
      sourceIsInbox ? mail.uid!.domain : mail.uid!.account;

    const sourceUids: number[] = [];
    const destUids: number[] = [];

    const Mail = (await import("common")).Mail;

    // No transaction wrapper around storeMail — `pgSaveMail` is a single
    // INSERT and the per-mail loop is sequential, so a mid-loop failure
    // leaves the already-stored copies in the destination. Documented as a
    // limitation; a follow-up issue can promote this loop to a single
    // multi-row INSERT or a transaction.
    for (const sourceMail of sourceMails) {
      const newMail = new Mail({
        // Preserve everything header- and content-shaped.
        subject: sourceMail.subject,
        date: sourceMail.date,
        html: sourceMail.html,
        text: sourceMail.text,
        from: sourceMail.from,
        cc: sourceMail.cc,
        bcc: sourceMail.bcc,
        replyTo: sourceMail.replyTo,
        envelopeFrom: sourceMail.envelopeFrom,
        envelopeTo: sourceMail.envelopeTo,
        attachments: sourceMail.attachments,
        messageId: sourceMail.messageId,
        insight: sourceMail.insight,
        // Flags carry over per RFC 3501 §6.4.7.
        read: sourceMail.read,
        saved: sourceMail.saved,
        deleted: sourceMail.deleted,
        draft: sourceMail.draft,
        answered: sourceMail.answered,
      });

      // Routing: the destination mailbox is identified to queries by the
      // mail's `to_address` (for received) or `sent`+address (for sent).
      // For INBOX targets, the existing `to_address` is fine — INBOX shows
      // every received mail in the user's domain. For per-account /
      // user-created targets, override `to_address` to the destination
      // account so the copy surfaces in the destination's mailbox view.
      // The `to_text` (the human-readable header text returned in FETCH
      // BODY[HEADER]) is preserved from the source so the client sees the
      // original recipient header — the override only affects routing.
      if (destIsInbox) {
        newMail.to = sourceMail.to;
      } else {
        newMail.to = {
          value: [{ address: destAccount, name: "" }],
          text: sourceMail.to?.text || destAccount,
        };
      }
      newMail.sent = destIsSent;

      // Fresh UIDs in the destination's UID space. Per RFC 3501 the
      // destination's UIDNEXT increments per copied message. `getDomainUidNext`
      // / `getAccountUidNext` are atomic at the DB layer (sequence/counter).
      const newDomainUid = await getDomainUidNext(user.id);
      const newAccountUid = await getAccountUidNext(user.id, destAccount);
      newMail.uid.domain = newDomainUid || 1;
      newMail.uid.account = newAccountUid || 1;

      const ok = await store.storeMail(newMail);
      if (!ok) {
        // Mid-loop failure. RFC 3501 says COPY should be atomic; we
        // best-effort the partial state and report NO. A future
        // improvement could wrap the loop in a transaction (see comment
        // above).
        write(`${tag} NO [SERVERBUG] COPY partially failed\r\n`);
        return;
      }

      sourceUids.push(srcUidOf(sourceMail));
      destUids.push(destIsInbox ? newMail.uid.domain : newMail.uid.account);
    }

    // RFC 4315 §2: untagged or tagged OK with [COPYUID uidvalidity
    // source-set dest-set] response code. Most servers attach it to the
    // tagged OK; doing the same here.
    const uidValidity = await getImapUidValidity(user.id);
    const sourceSet = formatUidSet(sourceUids);
    const destSet = formatUidSet(destUids);
    write(
      `${tag} OK [COPYUID ${uidValidity} ${sourceSet} ${destSet}] COPY completed\r\n`
    );
  } catch (error) {
    logger.error("COPY error", { component: "imap" }, error);
    write(`${tag} NO COPY failed\r\n`);
  }
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

    mail.draft = appendRequest.flags?.includes("\\Draft") || false;
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
    // RFC 3501 §5.1: INBOX is case-insensitive. SELECT canonicalizes
    // selectedMailbox to "INBOX"; APPEND must canonicalize the target to
    // match — otherwise a SELECT inbox + APPEND inbox sequence reads
    // `selectedMailbox === appendRequest.mailbox` as `"INBOX" === "inbox"`
    // (false), skipping onAppended (the sequence-mapping rebuild) and
    // leaving the next seq-numbered FETCH for the appended message
    // returning wrong/missing data.
    const targetMailbox = isInbox(appendRequest.mailbox)
      ? "INBOX"
      : appendRequest.mailbox;
    const account = boxToAccount(user.username, targetMailbox);
    const domainUid = await getDomainUidNext(user.id);
    const accountUid = await getAccountUidNext(user.id, account);
    mail.uid.domain = domainUid || 1;
    mail.uid.account = accountUid || 1;

    const result = await store.storeMail(mail);

    const uid = isInbox(targetMailbox) ? mail.uid.domain : mail.uid.account;

    if (result) {
      if (selectedMailbox === targetMailbox) {
        await onAppended();
      }
      const uidValidity = await getImapUidValidity(user.id);
      write(
        `${tag} OK [APPENDUID ${uidValidity} ${uid}] APPEND completed\r\n`
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
