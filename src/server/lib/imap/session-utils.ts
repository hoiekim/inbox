/**
 * Utility functions extracted from ImapSession
 * These are pure functions that don't require session state
 */

import { MailType } from "common";
import { PartialRange, BodySection, FetchDataItem, HeaderFieldsSection } from "./types";
import { formatHeaders, encodeText } from "./util";
import { getAttachment } from "server";
import { logger } from "server";

/**
 * Apply partial fetch range to content
 */
export const applyPartialFetch = (
  content: string,
  partial: PartialRange
): string => {
  const contentBuffer = Buffer.from(content, "utf8");

  // If start is beyond content length, return empty string
  if (partial.start >= contentBuffer.length) {
    return "";
  }

  // Calculate end position, ensuring we don't go beyond content length
  const endPos = Math.min(partial.start + partial.length, contentBuffer.length);

  return contentBuffer.subarray(partial.start, endPos).toString("utf8");
};

/**
 * Get the IMAP body section key for response formatting
 */
export const getBodySectionKey = (section: BodySection): string => {
  switch (section.type) {
    case "FULL":
      return "BODY[]";
    case "TEXT":
      return "BODY[TEXT]";
    case "HEADER":
      return "BODY[HEADER]";
    case "MIME_PART":
      return `BODY[${section.partNumber}${
        section.subSection ? "." + section.subSection : ""
      }]`;
    case "HEADER_FIELDS": {
      const hfs = section as HeaderFieldsSection;
      const fieldList = hfs.fields.join(" ");
      return hfs.not
        ? `BODY[HEADER.FIELDS.NOT (${fieldList})]`
        : `BODY[HEADER.FIELDS (${fieldList})]`;
    }
    default:
      return "BODY[]";
  }
};

/**
 * Check if any fetch data item should mark message as read
 */
export const shouldMarkAsRead = (dataItems: FetchDataItem[]): boolean => {
  // RFC822 ≡ BODY[] and RFC822.TEXT ≡ BODY[TEXT] are non-peek, so they set
  // \Seen like a non-peek BODY fetch. RFC822.HEADER ≡ BODY.PEEK[HEADER] is
  // peek-equivalent and never marks the message read (RFC 3501 §6.4.5).
  return dataItems.some(
    (item) =>
      (item.type === "BODY" && !item.peek) ||
      item.type === "RFC822" ||
      item.type === "RFC822.TEXT"
  );
};

/**
 * Byte length of `4 * ceil(n/3)`-format base64 encoding of `n` input octets.
 * No I/O; used by `computeFullMessageSize` to pre-compute the RFC822.SIZE
 * / `{N}` literal length for a mail without materializing its body.
 */
const base64ByteLen = (rawBytes: number): number =>
  Math.ceil(rawBytes / 3) * 4;

/**
 * The stable boundary strings a build for this mail would generate. Shared
 * between `computeFullMessageSize` (which needs their lengths) and
 * `buildFullMessageStream` (which emits them) so the byte counts agree by
 * construction.
 */
const boundariesFor = (
  mail: Partial<MailType>,
  headers: string,
  docId?: string
): { boundary: string; altBoundary: string } => {
  const boundaryMatch = headers.match(/boundary="([^"]+)"/);
  const stableId = docId || mail.messageId || "default";
  const boundary = boundaryMatch ? boundaryMatch[1] : "boundary_" + stableId;
  const altBoundary =
    "alt_" + stableId.replace(/[^a-zA-Z0-9_]/g, "_");
  return { boundary, altBoundary };
};

/**
 * Header block after the multipart Content-Type substitution — same string
 * `buildFullMessage`/`buildFullMessageStream` would emit as their first
 * chunk. Extracted so `computeFullMessageSize` measures the exact bytes
 * that will be sent, not an approximation.
 */
const rewriteContentType = (headers: string, replacement: string): string =>
  headers.replace(/Content-Type: [^\r\n]+/, replacement);

/**
 * Compute the exact WIRE byte count IMAP `{N}` literal advertises for
 * `BODY[]` — i.e. the byte length of the RFC 822 serialization the mail
 * would produce, PLUS the trailing `\r\n` the wire response appends
 * after the multipart terminator (matches the pre-#733 shape where
 * `getSharedBodyResult`'s closure appended `text + "\r\n"` before
 * emitting the literal). This IS the value RFC822.SIZE reports and
 * `{N}` literal advertises — the two agree by construction.
 *
 * Attachments are measured via the base64 length formula
 * (`ceil(size/3)*4`) applied to their stored `size` — no disk read, no
 * allocation. That's the whole point of this function: SIZE / `{N}`
 * without materializing bodies.
 */
export const computeFullMessageSize = (
  mail: Partial<MailType>,
  docId?: string
): number => {
  const headers = formatHeaders(mail, docId);
  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
  // Trailing wire CRLF appended after the pure-body serialization —
  // matches `getSharedBodyResult`'s closure that emitted `text + "\r\n"`
  // before building the response Buffer (see body-buffer.ts). Every
  // BODY[]/RFC822 wire response ends with this extra CRLF; RFC822.SIZE
  // includes it so `SIZE == {N}` holds.
  const WIRE_TRAILER = 2;

  if (!hasText && !hasHtml && !hasAttachments) {
    return utf8(`${headers}\r\n\r\n`) + WIRE_TRAILER;
  }
  if (hasText && !hasHtml && !hasAttachments) {
    return utf8(`${headers}\r\n\r\n${encodeText(mail.text!)}\r\n`) + WIRE_TRAILER;
  }
  if (!hasText && hasHtml && !hasAttachments) {
    return utf8(`${headers}\r\n\r\n${encodeText(mail.html!)}\r\n`) + WIRE_TRAILER;
  }

  const { boundary, altBoundary } = boundariesFor(mail, headers, docId);
  let bytes = 0;

  if (hasText && hasHtml && !hasAttachments) {
    const updatedHeaders = rewriteContentType(
      headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    );
    bytes += utf8(`${updatedHeaders}\r\n\r\n`);
    bytes += utf8(`--${boundary}\r\n`);
    bytes += utf8(`Content-Type: text/plain; charset=utf-8\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n\r\n`);
    bytes += utf8(`${encodeText(mail.text!)}\r\n`);
    bytes += utf8(`--${boundary}\r\n`);
    bytes += utf8(`Content-Type: text/html; charset=utf-8\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n\r\n`);
    bytes += utf8(`${encodeText(mail.html!)}\r\n`);
    bytes += utf8(`--${boundary}--`);
    return bytes + WIRE_TRAILER;
  }

  // hasAttachments — multipart/mixed
  const updatedHeaders = rewriteContentType(
    headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  );
  bytes += utf8(`${updatedHeaders}\r\n\r\n`);

  if (hasText && hasHtml) {
    bytes += utf8(`--${boundary}\r\n`);
    bytes += utf8(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`);
    bytes += utf8(`--${altBoundary}\r\n`);
    bytes += utf8(`Content-Type: text/plain; charset=utf-8\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n\r\n`);
    bytes += utf8(`${encodeText(mail.text!)}\r\n`);
    bytes += utf8(`--${altBoundary}\r\n`);
    bytes += utf8(`Content-Type: text/html; charset=utf-8\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n\r\n`);
    bytes += utf8(`${encodeText(mail.html!)}\r\n`);
    bytes += utf8(`--${altBoundary}--\r\n`);
  } else if (hasText) {
    bytes += utf8(`--${boundary}\r\n`);
    bytes += utf8(`Content-Type: text/plain; charset=utf-8\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n\r\n`);
    bytes += utf8(`${encodeText(mail.text!)}\r\n`);
  } else if (hasHtml) {
    bytes += utf8(`--${boundary}\r\n`);
    bytes += utf8(`Content-Type: text/html; charset=utf-8\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n\r\n`);
    bytes += utf8(`${encodeText(mail.html!)}\r\n`);
  }

  // Attachments — sum header + base64_len(raw size) + trailing CRLF
  // per attachment. `att.size` is the RAW attachment byte count stored
  // on the mail row; base64 length formula converts to the encoded
  // length WITHOUT ever reading the file. This is the whole point of
  // this function — RFC822.SIZE / {N} without materializing bodies.
  for (const att of mail.attachments!) {
    bytes += utf8(`--${boundary}\r\n`);
    bytes += utf8(`Content-Type: ${att.contentType}\r\n`);
    bytes += utf8(`Content-Transfer-Encoding: base64\r\n`);
    bytes += utf8(`Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n`);
    bytes += base64ByteLen(att.size);
    bytes += utf8(`\r\n`);
  }
  bytes += utf8(`--${boundary}--`);
  return bytes + WIRE_TRAILER;
};

/**
 * Stream the RFC 822 serialization of a mail as `Buffer` chunks. Each
 * yielded chunk is small (header block, one part header, one base64-
 * encoded slice of an attachment) so peak transient allocation stays
 * O(chunk-size) regardless of total body size — the whole point of the
 * streaming path.
 *
 * Attachments are base64-encoded in 48 KiB raw slices (~64 KiB encoded)
 * so a multi-MB attachment never materializes as a single base64 string.
 * `Buffer.toString("base64")` on a 48 KiB slice returns a ~64 KiB string
 * which is immediately wrapped in a Buffer and yielded — the temporary
 * string is GC-eligible before the next slice runs.
 *
 * The consumer (writer) must have advertised `{N}` where N ==
 * `computeFullMessageSize(mail, docId)` BEFORE iterating this stream —
 * both functions read from `mail.text` / `mail.html` / `mail.attachments`
 * with identical formulas, so the sum of yielded chunk byte-lengths
 * equals N by construction.
 */
const ATTACHMENT_SLICE_BYTES = 48 * 1024;

export async function* buildFullMessageStream(
  mail: Partial<MailType>,
  docId?: string
): AsyncGenerator<Buffer, void, unknown> {
  const headers = formatHeaders(mail, docId);
  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  const emit = (s: string): Buffer => Buffer.from(s, "utf8");

  if (!hasText && !hasHtml && !hasAttachments) {
    yield emit(`${headers}\r\n\r\n`);
    return;
  }
  if (hasText && !hasHtml && !hasAttachments) {
    yield emit(`${headers}\r\n\r\n${encodeText(mail.text!)}\r\n`);
    return;
  }
  if (!hasText && hasHtml && !hasAttachments) {
    yield emit(`${headers}\r\n\r\n${encodeText(mail.html!)}\r\n`);
    return;
  }

  if (!docId) {
    logger.warn(
      "docId is missing in buildFullMessageStream, falling back to messageId",
      { component: "imap", messageId: mail.messageId }
    );
  }
  const { boundary, altBoundary } = boundariesFor(mail, headers, docId);

  if (hasText && hasHtml && !hasAttachments) {
    const updatedHeaders = rewriteContentType(
      headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    );
    yield emit(`${updatedHeaders}\r\n\r\n`);
    yield emit(`--${boundary}\r\n`);
    yield emit(`Content-Type: text/plain; charset=utf-8\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n\r\n`);
    yield emit(`${encodeText(mail.text!)}\r\n`);
    yield emit(`--${boundary}\r\n`);
    yield emit(`Content-Type: text/html; charset=utf-8\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n\r\n`);
    yield emit(`${encodeText(mail.html!)}\r\n`);
    yield emit(`--${boundary}--`);
    return;
  }

  // hasAttachments — multipart/mixed
  const updatedHeaders = rewriteContentType(
    headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  );
  yield emit(`${updatedHeaders}\r\n\r\n`);

  if (hasText && hasHtml) {
    yield emit(`--${boundary}\r\n`);
    yield emit(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`);
    yield emit(`--${altBoundary}\r\n`);
    yield emit(`Content-Type: text/plain; charset=utf-8\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n\r\n`);
    yield emit(`${encodeText(mail.text!)}\r\n`);
    yield emit(`--${altBoundary}\r\n`);
    yield emit(`Content-Type: text/html; charset=utf-8\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n\r\n`);
    yield emit(`${encodeText(mail.html!)}\r\n`);
    yield emit(`--${altBoundary}--\r\n`);
  } else if (hasText) {
    yield emit(`--${boundary}\r\n`);
    yield emit(`Content-Type: text/plain; charset=utf-8\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n\r\n`);
    yield emit(`${encodeText(mail.text!)}\r\n`);
  } else if (hasHtml) {
    yield emit(`--${boundary}\r\n`);
    yield emit(`Content-Type: text/html; charset=utf-8\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n\r\n`);
    yield emit(`${encodeText(mail.html!)}\r\n`);
  }

  for (const att of mail.attachments!) {
    yield emit(`--${boundary}\r\n`);
    yield emit(`Content-Type: ${att.contentType}\r\n`);
    yield emit(`Content-Transfer-Encoding: base64\r\n`);
    yield emit(`Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n`);

    const raw =
      getAttachment(att.content.data) ||
      Buffer.from("Attachment data not found");

    // Slice size chosen so base64 encoding of the slice is `~64 KiB`
    // (matches CHUNK_BYTES in chunked-write.ts) — one write per slice
    // aligns naturally with the socket's high-water mark. `att.size`
    // in `computeFullMessageSize` uses the STORED size which for a
    // real attachment matches `raw.byteLength`; on a missing-file
    // fallback (`Buffer.from("Attachment data not found")`) the two
    // will disagree. Callers should treat rfc822_size derivation
    // separately from stream-emit in that pathological case.
    for (
      let offset = 0;
      offset < raw.byteLength;
      offset += ATTACHMENT_SLICE_BYTES
    ) {
      const sliceEnd = Math.min(offset + ATTACHMENT_SLICE_BYTES, raw.byteLength);
      const slice = raw.subarray(offset, sliceEnd);
      // `slice.toString("base64")` returns a fresh ~64 KiB string that
      // becomes GC-eligible right after `Buffer.from(...)` copies its
      // bytes into a new Buffer. Peak transient per slice: raw slice
      // (48 KiB, borrowed view) + intermediate string (~64 KiB) +
      // emitted Buffer (~64 KiB) = ~128 KiB. No growing accumulator.
      yield Buffer.from(slice.toString("base64"), "utf8");
    }
    yield emit(`\r\n`);
  }
  yield emit(`--${boundary}--`);
}

/**
 * Build complete RFC822 message from mail data as a single string.
 *
 * Legacy consumer-facing API — the stream-native path
 * (`buildFullMessageStream` + `computeFullMessageSize`) is preferred
 * for BODY[] / RFC822 fetches because it keeps peak allocation at
 * O(chunk-size). This function collects every stream chunk into an
 * array and joins at the end — the pragmatic middle ground for the
 * remaining callers that need a materialized string:
 *
 * - `getBodyContent` for the TEXT section: takes the full message
 *   string, `indexOf("\r\n\r\n") + substring` to extract the body.
 *   Small-mail-friendly; large-attachment mails still pay the
 *   materialization here.
 * - `scripts/backfill-rfc822-size.ts` for the one-off backfill —
 *   though that script really wants `Buffer.byteLength(full, "utf8")`,
 *   which is exactly `computeFullMessageSize` without materializing.
 *   A follow-up can migrate the backfill to `computeFullMessageSize`
 *   and drop this function's dependency on the string materialization
 *   for that path.
 *
 * Uses `chunks.push(str) + chunks.join("")` internally instead of the
 * earlier `let body = ""; body += X;` chain — `Array#join` is a single
 * O(total_length) allocation vs the quadratic rope-realloc buildup
 * that made this the OOM offender on #729's K836 case.
 */
export const buildFullMessage = (
  mail: Partial<MailType>,
  docId?: string
): string => {
  const headers = formatHeaders(mail, docId);
  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  if (!hasText && !hasHtml && !hasAttachments) {
    return `${headers}\r\n\r\n`;
  }

  if (hasText && !hasHtml && !hasAttachments) {
    return `${headers}\r\n\r\n${encodeText(mail.text!)}\r\n`;
  }

  if (!hasText && hasHtml && !hasAttachments) {
    return `${headers}\r\n\r\n${encodeText(mail.html!)}\r\n`;
  }

  if (!docId) {
    logger.warn("docId is missing in buildFullMessage, falling back to messageId", {
      component: "imap",
      messageId: mail.messageId
    });
  }
  const { boundary, altBoundary } = boundariesFor(mail, headers, docId);
  const chunks: string[] = [];

  if (hasText && hasHtml && !hasAttachments) {
    // multipart/alternative
    const updatedHeaders = rewriteContentType(
      headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    );

    chunks.push(`${updatedHeaders}\r\n\r\n`);
    chunks.push(`--${boundary}\r\n`);
    chunks.push(`Content-Type: text/plain; charset=utf-8\r\n`);
    chunks.push(`Content-Transfer-Encoding: base64\r\n\r\n`);
    chunks.push(`${encodeText(mail.text!)}\r\n`);
    chunks.push(`--${boundary}\r\n`);
    chunks.push(`Content-Type: text/html; charset=utf-8\r\n`);
    chunks.push(`Content-Transfer-Encoding: base64\r\n\r\n`);
    chunks.push(`${encodeText(mail.html!)}\r\n`);
    chunks.push(`--${boundary}--`);
  } else if (hasAttachments) {
    // multipart/mixed
    const updatedHeaders = rewriteContentType(
      headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    );

    chunks.push(`${updatedHeaders}\r\n\r\n`);

    if (hasText && hasHtml) {
      chunks.push(`--${boundary}\r\n`);
      chunks.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`);
      chunks.push(`--${altBoundary}\r\n`);
      chunks.push(`Content-Type: text/plain; charset=utf-8\r\n`);
      chunks.push(`Content-Transfer-Encoding: base64\r\n\r\n`);
      chunks.push(`${encodeText(mail.text!)}\r\n`);
      chunks.push(`--${altBoundary}\r\n`);
      chunks.push(`Content-Type: text/html; charset=utf-8\r\n`);
      chunks.push(`Content-Transfer-Encoding: base64\r\n\r\n`);
      chunks.push(`${encodeText(mail.html!)}\r\n`);
      chunks.push(`--${altBoundary}--\r\n`);
    } else if (hasText) {
      chunks.push(`--${boundary}\r\n`);
      chunks.push(`Content-Type: text/plain; charset=utf-8\r\n`);
      chunks.push(`Content-Transfer-Encoding: base64\r\n\r\n`);
      chunks.push(`${encodeText(mail.text!)}\r\n`);
    } else if (hasHtml) {
      chunks.push(`--${boundary}\r\n`);
      chunks.push(`Content-Type: text/html; charset=utf-8\r\n`);
      chunks.push(`Content-Transfer-Encoding: base64\r\n\r\n`);
      chunks.push(`${encodeText(mail.html!)}\r\n`);
    }

    for (const att of mail.attachments!) {
      chunks.push(`--${boundary}\r\n`);
      chunks.push(`Content-Type: ${att.contentType}\r\n`);
      chunks.push(`Content-Transfer-Encoding: base64\r\n`);
      chunks.push(`Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n`);
      const attachmentData =
        getAttachment(att.content.data) ||
        Buffer.from("Attachment data not found");
      chunks.push(`${attachmentData.toString("base64")}\r\n`);
    }

    chunks.push(`--${boundary}--`);
  }

  return chunks.join("");
};

/**
 * Get specific body part from multipart message
 */
export const getBodyPart = (
  mail: Partial<MailType>,
  partNum: string
): string | null => {
  const parts = partNum.split(".");
  const mainPart = parseInt(parts[0], 10);

  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  // Simple case: single part message
  if (!hasAttachments && !hasText && !hasHtml) {
    return null;
  }

  // Helper: base64-encode text content to match BODYSTRUCTURE encoding declaration
  const b64 = (str: string) => Buffer.from(str, "utf8").toString("base64");

  if (!hasAttachments) {
    if (hasText && hasHtml) {
      // multipart/alternative
      if (mainPart === 1) return b64(mail.text!);
      if (mainPart === 2) return b64(mail.html!);
    } else if (hasText && mainPart === 1) {
      return b64(mail.text!);
    } else if (hasHtml && mainPart === 1) {
      return b64(mail.html!);
    }
    return null;
  }

  // multipart/mixed with attachments
  let partIndex = 1;

  // First part is the body content
  if (mainPart === partIndex) {
    if (hasText && hasHtml) {
      // This would be a multipart/alternative part
      const subPart = parts[1] ? parseInt(parts[1], 10) : 1;
      if (subPart === 1) return b64(mail.text!);
      if (subPart === 2) return b64(mail.html!);
    } else if (hasText) {
      return b64(mail.text!);
    } else if (hasHtml) {
      return b64(mail.html!);
    }
  }

  partIndex++;

  // Subsequent parts are attachments — serve base64-encoded binary
  const attachmentIndex = mainPart - partIndex;
  if (
    mail.attachments &&
    attachmentIndex >= 0 &&
    attachmentIndex < mail.attachments.length
  ) {
    const att = mail.attachments[attachmentIndex];
    const data = getAttachment(att.content.data);
    return data ? data.toString("base64") : null;
  }

  return null;
};

/**
 * MIME header block for a specific body part (RFC 3501 §6.4.5 `BODY[<part>.MIME]`
 * / `BODY[<part>.HEADER]`). Returns the part's `Content-Type` +
 * `Content-Transfer-Encoding` (+ `Content-Disposition` for attachments) fields
 * with no trailing CRLF — the caller appends the delimiting blank line. Mirrors
 * `getBodyPart`'s part-numbering exactly so `BODY[1.MIME]` names the same part
 * as `BODY[1]`.
 */
export const getBodyPartHeaders = (
  mail: Partial<MailType>,
  partNum: string
): string | null => {
  const parts = partNum.split(".");
  const mainPart = parseInt(parts[0], 10);

  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  if (!hasAttachments && !hasText && !hasHtml) {
    return null;
  }

  const textHeaders =
    "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64";
  const htmlHeaders =
    "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64";

  if (!hasAttachments) {
    if (hasText && hasHtml) {
      // multipart/alternative
      if (mainPart === 1) return textHeaders;
      if (mainPart === 2) return htmlHeaders;
    } else if (hasText && mainPart === 1) {
      return textHeaders;
    } else if (hasHtml && mainPart === 1) {
      return htmlHeaders;
    }
    return null;
  }

  // multipart/mixed with attachments
  let partIndex = 1;

  // First part is the body content (possibly a nested multipart/alternative)
  if (mainPart === partIndex) {
    if (hasText && hasHtml) {
      const subPart = parts[1] ? parseInt(parts[1], 10) : 1;
      if (subPart === 1) return textHeaders;
      if (subPart === 2) return htmlHeaders;
    } else if (hasText) {
      return textHeaders;
    } else if (hasHtml) {
      return htmlHeaders;
    }
  }

  partIndex++;

  // Subsequent parts are attachments
  const attachmentIndex = mainPart - partIndex;
  if (
    mail.attachments &&
    attachmentIndex >= 0 &&
    attachmentIndex < mail.attachments.length
  ) {
    const att = mail.attachments[attachmentIndex];
    return (
      `Content-Type: ${att.contentType}\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${att.filename}"`
    );
  }

  return null;
};
