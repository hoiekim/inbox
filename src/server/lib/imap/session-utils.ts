/**
 * Utility functions extracted from ImapSession
 * These are pure functions that don't require session state
 */

import fs from "node:fs";
import { MailType } from "common";
import { PartialRange, BodySection, FetchDataItem, HeaderFieldsSection } from "./types";
import { formatHeaders } from "./util";
import { getAttachment, getAttachmentFilePath } from "server";
import { logger } from "server";
import { CHUNK_BYTES } from "./chunked-write";

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
 * One piece of the RFC 822 serialization.
 *
 * `buildMessageSegments` is the SINGLE definition of the MIME layout.
 * `sumSegmentBytes` measures the segments and `streamFromSegments`
 * emits them, so the `{N}` literal the writer advertises and the
 * octets that follow it are derived from one source and cannot
 * disagree. Keeping the layout in one place is the invariant,
 * not an aesthetic choice: three hand-parallel copies (measure, emit,
 * materialize) is how the count and the payload drift apart, and a
 * literal whose count is wrong desyncs every subsequent response on the
 * connection.
 */
export type MessageSegment =
  /** Emitted verbatim; measured with `Buffer.byteLength`. */
  | { kind: "literal"; value: string }
  /** `source` base64-encoded; sliced so the encoded form is never one allocation. */
  | { kind: "base64"; source: string }
  /** An attachment file, base64-encoded, read and emitted in slices. */
  | { kind: "attachment"; dataId: string; rawSize: number; filename: string };

/**
 * Byte length of `4 * ceil(n/3)`-format base64 encoding of `n` input octets.
 * Exact, and with no line folding — `encodeText` produces unfolded base64,
 * so this is the true encoded length rather than an estimate.
 */
const base64ByteLen = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

/**
 * Raw byte count emitted for an attachment whose file cannot be read.
 * Measured and emitted through the same constant so the two agree.
 */
const MISSING_ATTACHMENT_NOTICE = "Attachment data not found";

/**
 * Raw size of an attachment as it will actually be emitted.
 *
 * `stat` rather than the `size` stored on the mail row: the stored value is
 * what the sender declared at receipt, and when it disagrees with the file on
 * disk (or the file is gone) it is the file that gets streamed. Measuring the
 * stored value while emitting the file's bytes is exactly the divergence that
 * corrupts the literal. `stat` is a metadata call — no read, no allocation —
 * so this keeps `RFC822.SIZE` free of body materialization.
 */
const resolveAttachmentRawSize = (dataId: string): number => {
  try {
    const stats = fs.statSync(getAttachmentFilePath(dataId));
    if (stats.isFile()) return stats.size;
  } catch {
    // Missing / unreadable — fall through to the notice length below.
  }
  return Buffer.byteLength(MISSING_ATTACHMENT_NOTICE, "utf8");
};

/**
 * The stable boundary strings a build for this mail would generate.
 */
const boundariesFor = (
  mail: Partial<MailType>,
  headers: string,
  docId?: string
): { boundary: string; altBoundary: string } => {
  const boundaryMatch = headers.match(/boundary="([^"]+)"/);
  const stableId = docId || mail.messageId || "default";
  const boundary = boundaryMatch ? boundaryMatch[1] : "boundary_" + stableId;
  const altBoundary = "alt_" + stableId.replace(/[^a-zA-Z0-9_]/g, "_");
  return { boundary, altBoundary };
};

const rewriteContentType = (headers: string, replacement: string): string =>
  headers.replace(/Content-Type: [^\r\n]+/, replacement);

/**
 * The RFC 822 serialization of `mail`, as an ordered segment list.
 *
 * Attachment bodies are referenced by id + resolved size, never read, so
 * building the list costs one `stat` per attachment regardless of mail size.
 */
export const buildMessageSegments = (
  mail: Partial<MailType>,
  docId?: string
): MessageSegment[] => {
  const headers = formatHeaders(mail, docId);
  const hasText = !!mail.text && mail.text.trim().length > 0;
  const hasHtml = !!mail.html && mail.html.trim().length > 0;
  const hasAttachments = !!mail.attachments && mail.attachments.length > 0;

  const segments: MessageSegment[] = [];
  const literal = (value: string): void => {
    segments.push({ kind: "literal", value });
  };
  const base64 = (source: string): void => {
    segments.push({ kind: "base64", source });
  };

  if (!hasText && !hasHtml && !hasAttachments) {
    literal(`${headers}\r\n\r\n`);
    return segments;
  }
  if (hasText && !hasHtml && !hasAttachments) {
    literal(`${headers}\r\n\r\n`);
    base64(mail.text!);
    literal(`\r\n`);
    return segments;
  }
  if (!hasText && hasHtml && !hasAttachments) {
    literal(`${headers}\r\n\r\n`);
    base64(mail.html!);
    literal(`\r\n`);
    return segments;
  }

  if (!docId) {
    logger.warn("docId is missing in buildMessageSegments, falling back to messageId", {
      component: "imap",
      messageId: mail.messageId
    });
  }
  const { boundary, altBoundary } = boundariesFor(mail, headers, docId);

  /** One base64 body part: boundary, part headers, encoded payload, CRLF. */
  const bodyPart = (delimiter: string, contentType: string, source: string): void => {
    literal(`--${delimiter}\r\n`);
    literal(`Content-Type: ${contentType}; charset=utf-8\r\n`);
    literal(`Content-Transfer-Encoding: base64\r\n\r\n`);
    base64(source);
    literal(`\r\n`);
  };

  if (hasText && hasHtml && !hasAttachments) {
    literal(
      `${rewriteContentType(
        headers,
        `Content-Type: multipart/alternative; boundary="${boundary}"`
      )}\r\n\r\n`
    );
    bodyPart(boundary, "text/plain", mail.text!);
    bodyPart(boundary, "text/html", mail.html!);
    literal(`--${boundary}--`);
    return segments;
  }

  // hasAttachments — multipart/mixed
  literal(
    `${rewriteContentType(
      headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    )}\r\n\r\n`
  );

  if (hasText && hasHtml) {
    literal(`--${boundary}\r\n`);
    literal(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`);
    bodyPart(altBoundary, "text/plain", mail.text!);
    bodyPart(altBoundary, "text/html", mail.html!);
    literal(`--${altBoundary}--\r\n`);
  } else if (hasText) {
    bodyPart(boundary, "text/plain", mail.text!);
  } else if (hasHtml) {
    bodyPart(boundary, "text/html", mail.html!);
  }

  for (const att of mail.attachments!) {
    literal(`--${boundary}\r\n`);
    literal(`Content-Type: ${att.contentType}\r\n`);
    literal(`Content-Transfer-Encoding: base64\r\n`);
    literal(`Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n`);
    segments.push({
      kind: "attachment",
      dataId: att.content.data,
      rawSize: resolveAttachmentRawSize(att.content.data),
      filename: att.filename
    });
    literal(`\r\n`);
  }
  literal(`--${boundary}--`);
  return segments;
};

/** Exact wire byte count of one segment. No I/O, no allocation. */
const segmentByteLength = (segment: MessageSegment): number => {
  switch (segment.kind) {
    case "literal":
      return Buffer.byteLength(segment.value, "utf8");
    case "base64":
      return base64ByteLen(Buffer.byteLength(segment.source, "utf8"));
    case "attachment":
      return base64ByteLen(segment.rawSize);
  }
};

/**
 * Trailing `\r\n` the wire response appends after the body serialization.
 * `RFC822.SIZE` includes it so `SIZE == {N}` holds for `BODY[]`.
 */
const WIRE_TRAILER = 2;

/**
 * Sum the exact WIRE byte count for an already-built segment list. Used by
 * callers that need BOTH the size and the stream to derive from the SAME
 * segment list — building once, then measuring + streaming the same
 * segments — so no `stat` race can make the `{N}` literal disagree with the
 * emitted octets. See `buildBodyResponsePart` FULL branch.
 */
export const sumSegmentBytes = (segments: MessageSegment[]): number =>
  segments.reduce(
    (bytes, segment) => bytes + segmentByteLength(segment),
    WIRE_TRAILER
  );

/**
 * Exact WIRE byte count the IMAP `{N}` literal advertises for `BODY[]`, and
 * the value `RFC822.SIZE` reports. Convenience wrapper that builds + sums in
 * one call — safe for RFC822.SIZE (single build, no stream to disagree
 * with). For BODY[] the caller MUST share ONE segment list between
 * `sumSegmentBytes` (for `{N}`) and `streamFromSegments` (for the octets)
 * — see `buildBodyResponsePart` for the correct pattern.
 */
export const computeFullMessageSize = (
  mail: Partial<MailType>,
  docId?: string
): number => sumSegmentBytes(buildMessageSegments(mail, docId));

/**
 * Raw bytes per base64 slice. MUST be divisible by 3: base64 pads any input
 * whose length is not a multiple of 3, so a non-multiple slice size would
 * inject `=` padding at every slice boundary — corrupting the payload for the
 * client AND breaking the `ceil(n/3)*4` total the `{N}` literal advertises.
 * 48 KiB raw encodes to ~64 KiB, matching CHUNK_BYTES in chunked-write.ts so
 * one emitted chunk is roughly one socket write.
 */
const SLICE_RAW_BYTES = 48 * 1024;

if (SLICE_RAW_BYTES % 3 !== 0) {
  throw new Error(
    `SLICE_RAW_BYTES must be divisible by 3 to avoid mid-stream base64 padding, got ${SLICE_RAW_BYTES}`
  );
}

/** Emit `value` as byte-bounded chunks so one huge literal is not one write. */
async function* emitLiteral(value: string): AsyncGenerator<Buffer, void, unknown> {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= CHUNK_BYTES) {
    yield buffer;
    return;
  }
  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_BYTES) {
    yield buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.byteLength));
  }
}

/**
 * Emit `source` base64-encoded in sub-SLICE_RAW_BYTES slices. Peak transient
 * is O(SLICE_RAW_BYTES) regardless of source length — both input and output
 * are chunked, matching `emitAttachment`'s streaming shape.
 *
 * Two invariants the chunking has to preserve:
 * 1. **Surrogate pairs stay whole.** `source` is UTF-16; slicing at code-
 *    unit boundaries can land between the high and low half of an emoji.
 *    Each isolated half round-trips to U+FFFD (3 bytes), so a split pair
 *    emits 6 bytes where the whole encodes to 4 — a 2-byte wire overrun vs.
 *    the pre-measured `{N}` literal, corrupting every subsequent response
 *    on the connection. `end` is nudged back one code unit when it would
 *    land after a high surrogate.
 * 2. **Intermediate slices are 3-byte-aligned raw.** Base64 encodes 3 raw
 *    bytes to 4 chars; a non-multiple-of-3 slice emits `=` padding, and
 *    padded slices concatenated ≠ base64 of the concatenated raw. Residual
 *    (0–2 bytes) carries to the next iteration; the final slice is emitted
 *    whole (padding at the end is legal).
 */
async function* emitBase64(source: string): AsyncGenerator<Buffer, void, unknown> {
  if (source.length === 0) return;
  // Worst-case UTF-8 expansion is 3 bytes per BMP code unit (surrogate pairs
  // are 2 units → 4 bytes = 2 bytes/unit, cheaper). Slicing by
  // SLICE_RAW_BYTES/3 code units guarantees the encoded chunk stays under
  // SLICE_RAW_BYTES.
  const CHUNK_CODE_UNITS = Math.floor(SLICE_RAW_BYTES / 3);
  let carry: Buffer | null = null;
  let offset = 0;
  while (offset < source.length) {
    let end = Math.min(offset + CHUNK_CODE_UNITS, source.length);
    // If `end` lands after a high surrogate and there's a next slice, the
    // low surrogate would go to the next slice and both halves would
    // encode to U+FFFD. Back off one code unit so the whole pair goes in
    // the next slice.
    if (end < source.length && isHighSurrogate(source.charCodeAt(end - 1))) {
      end -= 1;
    }
    let bytes = Buffer.from(source.slice(offset, end), "utf8");
    offset = end;
    if (carry) {
      bytes = Buffer.concat([carry, bytes] as unknown as Uint8Array[]);
      carry = null;
    }
    if (offset < source.length) {
      // Align to multiple-of-3 and carry the residual to keep base64
      // concatenation lossless.
      const residualLen = bytes.byteLength % 3;
      if (residualLen > 0) {
        // Copy the trailing 1–2 bytes out so `bytes` can be GC'd — a
        // `subarray` view would pin the whole underlying ArrayBuffer.
        const tail = bytes.subarray(bytes.byteLength - residualLen);
        carry = Buffer.from(tail as unknown as Uint8Array);
        bytes = bytes.subarray(0, bytes.byteLength - residualLen);
      }
    }
    if (bytes.byteLength === 0) continue;
    yield Buffer.from(bytes.toString("base64"), "utf8");
  }
}

const isHighSurrogate = (charCode: number): boolean =>
  charCode >= 0xd800 && charCode <= 0xdbff;

/**
 * Emit an attachment base64-encoded, reading the file in slices through a
 * single descriptor so a multi-MB attachment never materializes whole.
 *
 * Emits EXACTLY `base64ByteLen(rawSize)` octets — the count already advertised
 * in `{N}`. If the file disagrees with the size resolved at measure time (it
 * changed, vanished, or became unreadable in between), the shortfall is padded
 * with newlines, which are legal inside a base64 body and ignored by decoders.
 * The client then sees one damaged attachment; emitting the true length instead
 * would desync the literal and corrupt every later response on the connection.
 * This function must never throw for the same reason: `{N}` is already on the
 * wire by the time it runs.
 */
async function* emitAttachment(
  segment: Extract<MessageSegment, { kind: "attachment" }>
): AsyncGenerator<Buffer, void, unknown> {
  const advertised = base64ByteLen(segment.rawSize);
  let emitted = 0;

  const emit = function* (encoded: string): Generator<Buffer, void, unknown> {
    const remaining = advertised - emitted;
    if (remaining <= 0) return;
    const buffer = Buffer.from(encoded, "utf8");
    const usable =
      buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
    emitted += usable.byteLength;
    yield usable;
  };

  let fd: number | undefined;
  try {
    fd = fs.openSync(getAttachmentFilePath(segment.dataId), "r");
    const scratch = Buffer.allocUnsafe(SLICE_RAW_BYTES);
    // Cast because Node's `readSync` types constrain the backing ArrayBuffer
    // more tightly than `Buffer.allocUnsafe`'s return; same idiom as
    // chunked-write.ts's `socket.write` call.
    const target = scratch as unknown as Uint8Array;
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, target, 0, SLICE_RAW_BYTES, position);
      if (read <= 0) break;
      position += read;
      yield* emit(scratch.subarray(0, read).toString("base64"));
      if (emitted >= advertised) break;
    }
  } catch (error) {
    logger.warn("Attachment unreadable while streaming BODY[]", {
      component: "imap",
      filename: segment.filename,
      err: error instanceof Error ? error.message : String(error)
    });
    yield* emit(Buffer.from(MISSING_ATTACHMENT_NOTICE, "utf8").toString("base64"));
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing actionable; the descriptor is already gone.
      }
    }
  }

  if (emitted < advertised) {
    logger.error("Attachment shorter than measured size; padding to hold the literal", {
      component: "imap",
      filename: segment.filename,
      advertised,
      emitted
    });
    yield Buffer.alloc(advertised - emitted, "\n");
  }
}

/**
 * Stream a pre-built segment list as `Buffer` chunks. Sum of yielded
 * byte-lengths equals `sumSegmentBytes(segments) - WIRE_TRAILER` — the
 * caller appends the wire trailer.
 *
 * **Load-bearing invariant:** the caller must share ONE segment list with
 * `sumSegmentBytes` for its `{N}` — reproducing the segment list here
 * (via `buildMessageSegments`) would `stat` files a second time and can
 * race the measurement pass, corrupting the wire response by up to
 * whatever the file's size changed by. That was hoiekim/inbox#733
 * reviewoie HIGH.
 */
export async function* streamFromSegments(
  segments: MessageSegment[]
): AsyncGenerator<Buffer, void, unknown> {
  for (const segment of segments) {
    switch (segment.kind) {
      case "literal":
        yield* emitLiteral(segment.value);
        break;
      case "base64":
        yield* emitBase64(segment.source);
        break;
      case "attachment":
        yield* emitAttachment(segment);
        break;
    }
  }
}

/**
 * Build the complete RFC 822 message as a single string.
 *
 * Materializing consumer for `getBodyContent`'s TEXT section, which needs
 * `indexOf("\r\n\r\n") + substring` over the whole message. Prefer
 * `streamFromSegments` (paired with `sumSegmentBytes` on the same
 * `buildMessageSegments` result) for BODY[] / RFC822 — this function's
 * peak allocation is O(message), which is what #729 was about.
 */
export const buildFullMessage = (mail: Partial<MailType>, docId?: string): string => {
  const parts: string[] = [];
  for (const segment of buildMessageSegments(mail, docId)) {
    switch (segment.kind) {
      case "literal":
        parts.push(segment.value);
        break;
      case "base64":
        parts.push(Buffer.from(segment.source, "utf8").toString("base64"));
        break;
      case "attachment": {
        // Same length clamp as the streaming path, so a string built here and a
        // stream emitted there are byte-identical and both match `{N}`.
        const advertised = base64ByteLen(segment.rawSize);
        let encoded: string;
        try {
          encoded = fs
            .readFileSync(getAttachmentFilePath(segment.dataId))
            .toString("base64");
        } catch {
          encoded = Buffer.from(MISSING_ATTACHMENT_NOTICE, "utf8").toString("base64");
        }
        if (encoded.length > advertised) encoded = encoded.slice(0, advertised);
        else if (encoded.length < advertised)
          encoded += "\n".repeat(advertised - encoded.length);
        parts.push(encoded);
        break;
      }
    }
  }
  return parts.join("");
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
