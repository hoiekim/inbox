/**
 * FETCH response building helpers.
 *
 * Pure/near-pure functions that construct IMAP FETCH response parts.
 * These need session context (selectedMailbox, write fn) passed as parameters.
 */

import { MailType } from "common";
import { logger } from "server";
import {
  encodeText,
  formatAddressList,
  formatBodyStructure,
  formatFlags,
  formatHeaders,
  formatInternalDate,
} from "./util";
import {
  applyPartialFetch,
  buildFullMessage,
  getBodyPart,
  getBodySectionKey,
} from "./session-utils";
import {
  BodyFetch,
  BodySection,
  FetchDataItem,
} from "./types";

// ---------------------------------------------------------------------------
// FetchResponsePart types (local to the fetch subsystem)
// ---------------------------------------------------------------------------

export type FetchResponsePart =
  | { type: "simple"; content: string }
  | { type: "literal"; content: string; header: string; length: number };

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export function buildEnvelope(mail: Partial<MailType>): string {
  const dateString = new Date(mail.date!).toUTCString();
  const subject = (mail.subject || "").replace(/"/g, '\\"');
  const from = formatAddressList(mail.from?.value);
  const to = formatAddressList(mail.to?.value);
  const cc = formatAddressList(mail.cc?.value);
  const bcc = formatAddressList(mail.bcc?.value);
  const messageId = mail.messageId || "<unknown@local>";

  return `("${dateString}" "${subject}" NIL NIL NIL (${from}) (${to}) (${cc}) (${bcc}) NIL "${messageId}")`;
}

// ---------------------------------------------------------------------------
// Body content extraction
// ---------------------------------------------------------------------------

export function getBodyContent(
  mail: Partial<MailType>,
  section: BodySection,
  docId: string
): string | null {
  switch (section.type) {
    case "FULL":
      return buildFullMessage(mail, docId);

    case "TEXT": {
      const fullMessage = buildFullMessage(mail, docId);
      const headerEndIndex = fullMessage.indexOf("\r\n\r\n");
      if (headerEndIndex !== -1) {
        return fullMessage.substring(headerEndIndex + 4);
      }
      return "";
    }

    case "HEADER":
      return formatHeaders(mail, docId) + "\r\n";

    case "HEADER_FIELDS": {
      const allHeaders = formatHeaders(mail, docId);
      const requestedFields = section.fields.map((f: string) => f.toUpperCase());
      const lines = allHeaders.split("\r\n");
      const filtered: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line === "") break;
        if (line.match(/^[ \t]/) && filtered.length > 0) {
          filtered[filtered.length - 1] += "\r\n" + line;
          i++;
          continue;
        }
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const fieldName = line.substring(0, colonIdx).toUpperCase();
          const include = section.not
            ? !requestedFields.includes(fieldName)
            : requestedFields.includes(fieldName);
          if (include) {
            filtered.push(line);
          }
        }
        i++;
      }
      return filtered.length > 0
        ? filtered.join("\r\n") + "\r\n\r\n"
        : "\r\n";
    }

    case "MIME_PART":
      return getBodyPart(mail, section.partNumber);

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Requested fields
// ---------------------------------------------------------------------------

export function getRequestedFields(dataItems: FetchDataItem[]): Set<keyof MailType> {
  const fields = new Set<keyof MailType>(["uid"]);

  for (const item of dataItems) {
    switch (item.type) {
      case "ENVELOPE":
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("date");
        fields.add("messageId");
        break;

      case "FLAGS":
        fields.add("read");
        fields.add("saved");
        fields.add("deleted");
        fields.add("draft");
        break;

      case "BODYSTRUCTURE":
        fields.add("text");
        fields.add("html");
        fields.add("attachments");
        break;

      case "BODY":
        addBodyFields(item, fields);
        break;

      case "INTERNALDATE":
        fields.add("date");
        break;

      case "RFC822.SIZE":
        fields.add("text");
        fields.add("html");
        fields.add("attachments");
        break;
    }
  }

  return fields;
}

export function addBodyFields(
  bodyFetch: BodyFetch,
  fields: Set<keyof MailType>
): void {
  switch (bodyFetch.section.type) {
    case "FULL":
      fields.add("text");
      fields.add("html");
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("date");
      fields.add("messageId");
      fields.add("attachments");
      break;

    case "TEXT":
      fields.add("text");
      fields.add("html");
      fields.add("attachments");
      break;

    case "HEADER":
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("date");
      fields.add("messageId");
      break;

    case "HEADER_FIELDS": {
      const headerFieldMap: Record<string, (keyof MailType)[]> = {
        "FROM": ["from"],
        "TO": ["to"],
        "CC": ["cc"],
        "BCC": ["bcc"],
        "REPLY-TO": ["replyTo"],
        "SUBJECT": ["subject"],
        "DATE": ["date"],
        "MESSAGE-ID": ["messageId"],
      };
      const requested = bodyFetch.section.fields ?? [];
      if (bodyFetch.section.not) {
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("date");
        fields.add("messageId");
      } else {
        for (const f of requested) {
          const mapped = headerFieldMap[f.toUpperCase()];
          if (mapped) mapped.forEach((k) => fields.add(k));
        }
      }
      break;
    }

    case "MIME_PART":
      fields.add("text");
      fields.add("html");
      fields.add("attachments");
      break;
  }
}

// ---------------------------------------------------------------------------
// convertSequenceSet
// ---------------------------------------------------------------------------

export function convertSequenceSet(
  sequenceSet: import("./types").SequenceSet
): { start: number; end: number }[] {
  return sequenceSet.ranges.map(({ start, end = start }) => ({ start, end }));
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export async function buildBodyResponsePart(
  mail: Partial<MailType>,
  bodyFetch: BodyFetch,
  docId: string,
  selectedMailbox: string
): Promise<FetchResponsePart | null> {
  void selectedMailbox; // reserved for future per-mailbox logic
  const { section, partial } = bodyFetch;

  const content = getBodyContent(mail, section, docId);
  if (content === null) {
    return null;
  }

  const sectionKey = getBodySectionKey(section);
  let header = sectionKey;
  let finalContent = content;
  let length = Buffer.byteLength(finalContent, "utf8");

  if (finalContent === "" || (partial && partial.start >= length)) {
    return { type: "simple", content: `${sectionKey} NIL` };
  }

  if (partial) {
    const { start, length: partialLength } = partial;
    const end = start + partialLength;
    if (0 < start || end < length) {
      finalContent = applyPartialFetch(content, partial);
      length = Buffer.byteLength(finalContent, "utf8");
    }
    header += `<${start}.${Math.min(partialLength, length)}>`;
    finalContent += "\r\n";
  } else if (section.type !== "HEADER") {
    finalContent += "\r\n";
    length = Buffer.byteLength(finalContent, "utf8");
  }

  return { type: "literal", content: finalContent, header, length };
}

export async function buildFetchResponsePart(
  mail: Partial<MailType>,
  item: FetchDataItem,
  docId: string,
  selectedMailbox: string
): Promise<FetchResponsePart | null> {
  switch (item.type) {
    case "UID": {
      const isDomainInbox = selectedMailbox === "INBOX";
      const uid = isDomainInbox ? mail.uid!.domain : mail.uid!.account;
      return { type: "simple", content: `UID ${uid}` };
    }

    case "FLAGS": {
      const flags = formatFlags(mail);
      return { type: "simple", content: `FLAGS (${flags.join(" ")})` };
    }

    case "INTERNALDATE": {
      const date = mail.date ? new Date(mail.date) : new Date();
      const internalDate = formatInternalDate(date);
      return { type: "simple", content: `INTERNALDATE "${internalDate}"` };
    }

    case "RFC822.SIZE": {
      const encodedText = encodeText(mail.text || "");
      const textSize = Buffer.byteLength(encodedText, "utf-8");
      const encodedHtml = encodeText(mail.html || "");
      const htmlSize = Buffer.byteLength(encodedHtml, "utf-8");
      const attachmentSize = (mail.attachments ?? []).reduce(
        (acc, { size }) => acc + (size ? Math.ceil(size / 3) * 4 : 0),
        0
      );
      const size = textSize + htmlSize + attachmentSize;
      return { type: "simple", content: `RFC822.SIZE ${size}` };
    }

    case "ENVELOPE": {
      const envelope = buildEnvelope(mail);
      return { type: "simple", content: `ENVELOPE ${envelope}` };
    }

    case "BODYSTRUCTURE": {
      const bodyStructure = formatBodyStructure(mail);
      return { type: "simple", content: `BODYSTRUCTURE ${bodyStructure}` };
    }

    case "BODY":
      return buildBodyResponsePart(mail, item, docId, selectedMailbox);

    default:
      return null;
  }
}

export async function buildFetchResponse(
  mail: Partial<MailType>,
  dataItems: FetchDataItem[],
  docId: string,
  uid: number,
  isUidFetch: boolean,
  selectedMailbox: string
): Promise<FetchResponsePart[]> {
  const parts: FetchResponsePart[] = [];

  if (isUidFetch) {
    parts.push({ type: "simple", content: `UID ${uid}` });
  }

  for (const item of dataItems) {
    if (item.type === "UID" && isUidFetch) continue;
    const part = await buildFetchResponsePart(mail, item, docId, selectedMailbox);
    if (part) parts.push(part);
  }

  return parts;
}

export function writeFetchResponse(
  write: (data: string) => boolean | undefined,
  seqNum: number,
  parts: FetchResponsePart[]
) {
  write(`* ${seqNum} FETCH (`);

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) write(" ");

    const part = parts[i];
    if (part.type === "literal") {
      write(`${part.header} {${part.length}}\r\n${part.content}`);
    } else {
      write(part.content);
    }
  }

  write(")\r\n");
}
