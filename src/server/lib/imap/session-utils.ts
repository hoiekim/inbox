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
import { pgTextChunks, pgByteChunks } from "server";
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
  /**
   * Emitted verbatim; measured with `Buffer.byteLength`.
   *
   * `role` distinguishes structural framing (`"headers"` = the top-level
   * RFC 2822 header block, `"framing"` = MIME boundary / part header /
   * closing delimiter) from body-content literals (rare — typically
   * absent, since text/html/attachment payloads use their own segment
   * kinds). The `BODY[TEXT]` streamer uses `role === "headers"` to skip
   * the top header block and emit everything after; the `BODY[<part>]`
   * streamer uses `partPath` to select only the part-body segments.
   */
  | { kind: "literal"; value: string; role?: "headers" | "framing" }
  /**
   * `source` base64-encoded; sliced so the encoded form is never one
   * allocation. `partPath` (when set) is the RFC 3501 part number this
   * body belongs to (`"1"`, `"1.2"`, `"2"`, ...) — used by
   * `BODY[<part>]` to select this segment.
   */
  | { kind: "base64"; source: string; partPath?: string }
  /**
   * An attachment file, base64-encoded, read and emitted in slices.
   * `partPath` = its RFC 3501 part number for `BODY[<part>]` addressing.
   */
  | {
      kind: "attachment";
      dataId: string;
      rawSize: number;
      filename: string;
      partPath?: string;
    }
  /**
   * A `mails.text` or `mails.html` column, streamed via chunked
   * `SUBSTRING` reads and base64-encoded. `byteLength` is the raw
   * `octet_length(<col>)` measured at range-read time (see
   * `PartialMailModel.text_octets` / `html_octets`), so the encoded byte
   * count is pinned before the first chunk yields — the `{N}` literal
   * cannot race the stream. `partPath` = RFC 3501 part number for
   * `BODY[<part>]` addressing.
   */
  | {
      kind: "lazy-text";
      source: "text" | "html";
      mail_id: string;
      user_id: string;
      byteLength: number;
      partPath?: string;
    };

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
 * A mail argument that may carry either the materialized body strings
 * (`text` / `html` on the `MailType` shape) or the streaming metadata (the
 * four `text_octets` / `html_octets` / `mail_id` / `user_id` fields
 * projected by `getMailsByRange`). When all four streaming fields are set
 * and the strings are absent, `buildMessageSegments` emits `lazy-text`
 * segments — the body is streamed from Postgres via chunked SUBSTRING
 * reads instead of being held in Node's heap.
 */
export type FetchMailInput = Partial<MailType> & {
  text_octets?: number;
  html_octets?: number;
  mail_id?: string;
  user_id?: string;
};

/** True iff the four synthetic fields are all set AND neither string is loaded. */
const wantsLazyBodies = (mail: FetchMailInput): boolean =>
  typeof mail.text_octets === "number" &&
  typeof mail.html_octets === "number" &&
  typeof mail.mail_id === "string" &&
  typeof mail.user_id === "string" &&
  mail.text === undefined &&
  mail.html === undefined;

/**
 * The RFC 822 serialization of `mail`, as an ordered segment list.
 *
 * Attachment bodies are referenced by id + resolved size, never read, so
 * building the list costs one `stat` per attachment regardless of mail size.
 *
 * When the caller opts into streaming (`wantsLazyBodies` — the four
 * synthetic fields set, no `text` / `html` strings), the text/html body
 * parts are emitted as `lazy-text` segments that read the column in chunked
 * SUBSTRING reads at stream time. Peak transient per BODY[] fetch drops
 * from O(body-length) to O(chunk).
 */
export const buildMessageSegments = (
  mail: FetchMailInput,
  docId?: string
): MessageSegment[] => {
  const headers = formatHeaders(mail, docId);
  const isLazy = wantsLazyBodies(mail);
  // In lazy mode, `hasText`/`hasHtml` derive from `octet_length()` — the
  // materialized `.trim()` check isn't possible without loading the column.
  // A non-zero octet count is treated as "has content" even if the content
  // is whitespace-only. Whitespace-only bodies are pathological in real
  // mail and callers that need the trim-check semantics stay on the
  // materialized path (pass `mail.text` / `mail.html`).
  const hasText = isLazy
    ? mail.text_octets! > 0
    : !!mail.text && mail.text.trim().length > 0;
  const hasHtml = isLazy
    ? mail.html_octets! > 0
    : !!mail.html && mail.html.trim().length > 0;
  const hasAttachments = !!mail.attachments && mail.attachments.length > 0;

  const segments: MessageSegment[] = [];
  // `role` distinguishes the top-level RFC 2822 header block from MIME
  // framing so `BODY[TEXT]` (skip headers, emit rest) and
  // `BODY[<part>]` (select by partPath) can both filter without a
  // second segment build. Default is `"framing"`; the header-block
  // literal explicitly uses `"headers"`.
  const literal = (value: string, role: "headers" | "framing" = "framing"): void => {
    segments.push({ kind: "literal", value, role });
  };
  // Picks a `lazy-text` segment in lazy mode, a `base64` segment otherwise.
  // Both encode to identical wire bytes for the same input column (see the
  // split-input parity tests on emitBase64 in commit 2). `partPath` is the
  // RFC 3501 part number this body belongs to (`"1"`, `"1.2"`, `"2"`, ...) —
  // stamps the segment so `BODY[<part>]` can filter to just this one.
  const pushBody = (which: "text" | "html", partPath?: string): void => {
    if (isLazy) {
      segments.push({
        kind: "lazy-text",
        source: which,
        mail_id: mail.mail_id!,
        user_id: mail.user_id!,
        byteLength: which === "text" ? mail.text_octets! : mail.html_octets!,
        partPath,
      });
    } else {
      segments.push({
        kind: "base64",
        source: (which === "text" ? mail.text! : mail.html!),
        partPath,
      });
    }
  };

  if (!hasText && !hasHtml && !hasAttachments) {
    literal(`${headers}\r\n\r\n`, "headers");
    return segments;
  }
  if (hasText && !hasHtml && !hasAttachments) {
    literal(`${headers}\r\n\r\n`, "headers");
    pushBody("text", "1");
    literal(`\r\n`);
    return segments;
  }
  if (!hasText && hasHtml && !hasAttachments) {
    literal(`${headers}\r\n\r\n`, "headers");
    pushBody("html", "1");
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
  const bodyPart = (
    delimiter: string,
    contentType: string,
    which: "text" | "html",
    partPath: string
  ): void => {
    literal(`--${delimiter}\r\n`);
    literal(`Content-Type: ${contentType}; charset=utf-8\r\n`);
    literal(`Content-Transfer-Encoding: base64\r\n\r\n`);
    pushBody(which, partPath);
    literal(`\r\n`);
  };

  if (hasText && hasHtml && !hasAttachments) {
    // multipart/alternative — top-level parts 1 (text) and 2 (html).
    literal(
      `${rewriteContentType(
        headers,
        `Content-Type: multipart/alternative; boundary="${boundary}"`
      )}\r\n\r\n`,
      "headers"
    );
    bodyPart(boundary, "text/plain", "text", "1");
    bodyPart(boundary, "text/html", "html", "2");
    literal(`--${boundary}--`);
    return segments;
  }

  // hasAttachments — multipart/mixed. Part numbering per RFC 3501 §6.4.5 +
  // `getBodyPart`:
  //   - text+html: alternative wrapper is part 1 with sub-parts 1.1 (text)
  //     and 1.2 (html); attachments start at part 2.
  //   - text-only or html-only: the single body is part 1; attachments
  //     start at part 2.
  literal(
    `${rewriteContentType(
      headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    )}\r\n\r\n`,
    "headers"
  );

  let nextAttachmentPart = 1;
  if (hasText && hasHtml) {
    literal(`--${boundary}\r\n`);
    literal(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`);
    bodyPart(altBoundary, "text/plain", "text", "1.1");
    bodyPart(altBoundary, "text/html", "html", "1.2");
    literal(`--${altBoundary}--\r\n`);
    nextAttachmentPart = 2;
  } else if (hasText) {
    bodyPart(boundary, "text/plain", "text", "1");
    nextAttachmentPart = 2;
  } else if (hasHtml) {
    bodyPart(boundary, "text/html", "html", "1");
    nextAttachmentPart = 2;
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
      filename: att.filename,
      partPath: String(nextAttachmentPart),
    });
    literal(`\r\n`);
    nextAttachmentPart += 1;
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
    case "lazy-text":
      // The raw byte count comes from `octet_length()` at range-read time —
      // measured server-side against the same value the stream will pull, so
      // the `{N}` literal cannot disagree with the pgTextChunks output.
      return base64ByteLen(segment.byteLength);
  }
};

/**
 * Trailing `\r\n` the wire response appends after the body serialization.
 * `RFC822.SIZE` includes it so `SIZE == {N}` holds for `BODY[]`.
 * Exported so the partial-fetch code path in `buildBodyResponsePart` can
 * subtract it from `sumSegmentBytes(segments)` — partial fetches address
 * RFC 2822 bytes only and don't include the IMAP wire trailer.
 */
export const WIRE_TRAILER = 2;

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
  mail: FetchMailInput,
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
 * `source` may be a whole string (the legacy shape — for callers that hold
 * `mail.text` / `mail.html` in memory) OR an `AsyncIterable<string>` (the
 * streaming shape — for the pg SUBSTRING chunk reader). Both feed the same
 * carry-aware core so a source split into N chunks produces byte-identical
 * output to the same source as one string.
 *
 * Three invariants the chunking has to preserve:
 * 1. **Surrogate pairs stay whole.** JavaScript strings are UTF-16; slicing
 *    at code-unit boundaries can land between the high and low half of an
 *    emoji. Each isolated half round-trips to U+FFFD (3 bytes), so a split
 *    pair emits 6 bytes where the whole encodes to 4 — a 2-byte wire
 *    overrun vs. the pre-measured `{N}` literal, corrupting every
 *    subsequent response on the connection. `end` is nudged back one code
 *    unit when it would land after a high surrogate AND there is more input
 *    coming (either later in the buffered string, or in a later upstream
 *    chunk). The `unless-source-is-done` guard on that latter case is what
 *    keeps a genuinely-lone high surrogate at the tail encoding to U+FFFD
 *    (same as `Buffer.from(str, "utf8")`) instead of getting orphaned.
 * 2. **Intermediate slices are 3-byte-aligned raw.** Base64 encodes 3 raw
 *    bytes to 4 chars; a non-multiple-of-3 slice emits `=` padding, and
 *    padded slices concatenated ≠ base64 of the concatenated raw. Residual
 *    (0–2 bytes) carries to the next iteration; the final slice is emitted
 *    whole (padding at the end is legal).
 * 3. **Bytes concatenate across upstream chunks.** For chunked sources, a
 *    multi-byte UTF-8 sequence never straddles a chunk boundary at the
 *    STRING level (`charBuf += value` keeps the string intact before UTF-8
 *    encoding), and both the surrogate carry (a lone high surrogate at the
 *    end of a buffered chunk) and the byte-alignment carry (0–2 residual
 *    bytes) survive across upstream refills.
 */
async function* emitBase64(
  source: string | AsyncIterable<string>
): AsyncGenerator<Buffer, void, unknown> {
  if (typeof source === "string") {
    if (source.length === 0) return;
    yield* emitBase64Chunks(singleStringSource(source));
    return;
  }
  yield* emitBase64Chunks(source);
}

/** Adapt a single string to the async chunk iterable shape. */
async function* singleStringSource(s: string): AsyncGenerator<string, void, unknown> {
  yield s;
}

async function* emitBase64Chunks(
  source: AsyncIterable<string>
): AsyncGenerator<Buffer, void, unknown> {
  // Worst-case UTF-8 expansion is 3 bytes per BMP code unit (surrogate pairs
  // are 2 units → 4 bytes = 2 bytes/unit, cheaper). Slicing by
  // SLICE_RAW_BYTES/3 code units guarantees the encoded chunk stays under
  // SLICE_RAW_BYTES.
  const CHUNK_CODE_UNITS = Math.floor(SLICE_RAW_BYTES / 3);
  let byteCarry: Buffer | null = null;
  let charBuf = "";
  let done = false;
  const it = source[Symbol.asyncIterator]();

  const pullOne = async (): Promise<boolean> => {
    if (done) return false;
    const { value, done: d } = await it.next();
    if (d) {
      done = true;
      return false;
    }
    if (typeof value === "string" && value.length > 0) {
      charBuf += value;
      return true;
    }
    return false;
  };

  const fillAtLeast = async (n: number): Promise<void> => {
    // pullOne returns false on both done AND empty-string yields — either
    // way don't spin. A well-behaved iterable eventually either yields
    // content or ends; a pathological one that yields "" forever without
    // done just stops filling, and the outer loop breaks on `charBuf.length
    // === 0`.
    while (charBuf.length < n && !done) {
      if (!(await pullOne())) break;
    }
  };

  while (charBuf.length > 0 || !done) {
    // Need CHUNK_CODE_UNITS + 1 chars to detect a trailing high surrogate at
    // position CHUNK_CODE_UNITS-1 with certainty; if upstream ends sooner,
    // take whatever we have.
    await fillAtLeast(CHUNK_CODE_UNITS + 1);
    if (charBuf.length === 0) break;

    let end = Math.min(CHUNK_CODE_UNITS, charBuf.length);
    const isHighSurrogateAtEnd = isHighSurrogate(charBuf.charCodeAt(end - 1));
    if (isHighSurrogateAtEnd) {
      // Nudge back one code unit so the pair stays whole. Two cases:
      //  (a) `end < charBuf.length` — the low half is in charBuf; the next
      //      slice picks up the pair. Always nudge.
      //  (b) `end === charBuf.length && !done` — the low half might still be
      //      coming from upstream. Nudge and let the next iteration's fill
      //      pull it in.
      //  (c) `end === charBuf.length && done` — no more input; the high
      //      surrogate is genuinely lone. Emit as-is (Buffer.from will encode
      //      it to U+FFFD, matching the whole-string path).
      if (end < charBuf.length || !done) end -= 1;
    }

    let bytes = Buffer.from(charBuf.slice(0, end), "utf8");
    charBuf = charBuf.slice(end);

    if (byteCarry) {
      bytes = Buffer.concat([byteCarry, bytes] as unknown as Uint8Array[]);
      byteCarry = null;
    }

    // Determine whether this is the FINAL slice: charBuf empty AND upstream
    // exhausted. If charBuf is empty but upstream is still open, drain one
    // more pull so the answer is definite (necessary so a residual only
    // carries when there is actually more base64 to emit afterwards).
    if (charBuf.length === 0 && !done) await pullOne();
    const isFinal = charBuf.length === 0 && done;

    if (!isFinal) {
      // Align to multiple-of-3 and carry the residual to keep base64
      // concatenation lossless.
      const residualLen = bytes.byteLength % 3;
      if (residualLen > 0) {
        // Copy the trailing 1–2 bytes out so `bytes` can be GC'd — a
        // `subarray` view would pin the whole underlying ArrayBuffer.
        const tail = bytes.subarray(bytes.byteLength - residualLen);
        byteCarry = Buffer.from(tail as unknown as Uint8Array);
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
 * Emit `source` (a stream of raw UTF-8 bytes) base64-encoded. Sibling of
 * `emitBase64` for byte-typed sources — used by the offset-aware
 * `lazy-text` partial-fetch path (`streamLazyTextPartial`), which reads
 * via `pgByteChunks` and skips the UTF-16 surrogate juggling that
 * `emitBase64Chunks` needs for JS-string sources.
 *
 * Correctness pivots on the SAME 3-byte-alignment invariant as
 * `emitBase64Chunks`: intermediate slices are multiple-of-3 raw bytes so
 * their base64 concatenates losslessly; residual 0-2 bytes carry to the
 * next iteration; the final slice is emitted whole (base64 padding at
 * the end is legal). `pgByteChunks` already ships chunks aligned to
 * `PG_TEXT_CHUNK_BYTES % 3 === 0`, so the only chunk that can be
 * non-aligned is the tail terminator — and that one is the final slice
 * by construction.
 *
 * Uses `for await (... of source)` so a consumer that early-returns
 * (e.g. `sliceStream` once its `take` is satisfied) propagates
 * `.return()` down through this generator to `pgByteChunks`,
 * short-circuiting its SUBSTRING loop. Correctness needs to know when
 * the LAST chunk arrives so it can emit the residual whole; we track it
 * with a one-chunk-behind `pending` buffer — every loop iteration emits
 * the *previous* chunk as non-final and defers the current one, so the
 * final flush after the loop knows it holds the tail.
 */
async function* emitBase64FromBytes(
  source: AsyncIterable<Buffer>
): AsyncGenerator<Buffer, void, unknown> {
  let pending: Buffer | null = null;
  let carry: Buffer | null = null;
  for await (const raw of source) {
    if (raw.byteLength === 0) continue;
    if (pending !== null) {
      // `pending` is known non-final (we have `raw` following it). Carry
      // its 0-2-byte residual so base64 concatenates losslessly across
      // the boundary.
      let chunk: Buffer = pending;
      if (carry !== null) {
        chunk = Buffer.concat([carry, chunk] as unknown as Uint8Array[]);
        carry = null;
      }
      const residualLen = chunk.byteLength % 3;
      if (residualLen > 0) {
        const tail = chunk.subarray(chunk.byteLength - residualLen);
        carry = Buffer.from(tail as unknown as Uint8Array);
        chunk = chunk.subarray(0, chunk.byteLength - residualLen);
      }
      if (chunk.byteLength > 0) {
        yield Buffer.from(chunk.toString("base64"), "utf8");
      }
    }
    pending = raw;
  }
  // On loop exit `pending` is either the tail chunk (source yielded at
  // least once) or null (source empty). `carry` is only ever assigned
  // in the branch above that also assigns `pending`, so `pending === null`
  // implies `carry === null` — no separate carry-only flush case exists.
  if (pending !== null) {
    let chunk: Buffer = pending;
    if (carry !== null) {
      chunk = Buffer.concat([carry, chunk] as unknown as Uint8Array[]);
    }
    if (chunk.byteLength > 0) {
      yield Buffer.from(chunk.toString("base64"), "utf8");
    }
  }
}

/**
 * Test-only handle on `emitBase64` — the split-input parity tests exercise
 * it directly (feeding the same source as `[whole]` vs. `[chunkA, chunkB]`
 * vs. `[char, char, ...]`) to guarantee an upstream chunk boundary can
 * never desync the base64 output from the whole-string encoding. Prefixed
 * with `_` so it reads as internal at every call site.
 */
export const _emitBase64ForTests = emitBase64;

/**
 * Test-only handle on `emitBase64FromBytes` — same split-input parity
 * discipline as `_emitBase64ForTests` but for the byte-source sibling used
 * by `streamLazyTextPartial`.
 */
export const _emitBase64FromBytesForTests = emitBase64FromBytes;

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
    yield* streamOneSegment(segment);
  }
}

/**
 * Consume `source` from the byte offset `skip`, emit at most `take` bytes,
 * then stop. Sub-chunk trimming happens at the intersection of `source`'s
 * chunk boundaries and the [skip, skip+take) window — so a large chunk that
 * straddles the window gets sliced to only its overlap, and the tail of
 * `source` past `skip+take` is never pulled.
 *
 * Peak transient stays chunk-bounded by construction: at any moment we hold
 * one `Buffer` view (a `subarray` of the upstream chunk) or nothing. The
 * upstream generator is closed on early return via for-await semantics
 * (`.return()` on the iterator), so if the underlying source holds resources
 * (pgTextChunks cursor, fs descriptor) they release the moment the take is
 * satisfied. That's the mechanism that makes a partial-fetch BODY[] pull
 * exactly its `<start.length>` window and stop, instead of driving the
 * segment through to completion.
 */
async function* sliceStream(
  source: AsyncIterable<Buffer>,
  skip: number,
  take: number
): AsyncGenerator<Buffer, void, unknown> {
  if (take <= 0) return;
  let skipped = 0;
  let taken = 0;
  for await (const chunk of source) {
    if (taken >= take) return;
    let start = 0;
    if (skipped < skip) {
      const skipHere = Math.min(chunk.byteLength, skip - skipped);
      skipped += skipHere;
      start = skipHere;
    }
    if (start >= chunk.byteLength) continue;
    const remaining = take - taken;
    const end = Math.min(chunk.byteLength, start + remaining);
    // subarray is a view; copy out so early-return releases the upstream
    // chunk's backing ArrayBuffer instead of pinning it.
    const view = chunk.subarray(start, end);
    const emit =
      view.byteLength === chunk.byteLength
        ? chunk
        : Buffer.from(view as unknown as Uint8Array);
    taken += emit.byteLength;
    yield emit;
    if (taken >= take) return;
  }
}

/**
 * Emit exactly the bytes `[start, start+length)` of the segment
 * concatenation. Same output as `Buffer.concat(...streamFromSegments(segs))
 * .subarray(start, start + length)`, but never materializes the whole
 * concatenation and stops pulling the moment `take` is satisfied.
 *
 * Byte-offset walk: for each segment we know its exact wire byte count
 * (`segmentByteLength`), so we skip segments entirely before the window,
 * stop on the first segment entirely after it, and slice-in-flight through
 * `sliceStream` on the ones that overlap.
 *
 * This is the streaming path for `BODY[]<start.length>` — the RFC 3501
 * §6.4.5 partial-fetch form. iOS Mail uses it for essentially every
 * body fetch (verified via #758 attribution: 25/25 partial vs 0/25 full
 * stream in the sample window). Before this fn, partial fell to
 * `buildFullMessage` which materialized the whole RFC 2822 serialization
 * then sliced; peak allocation was O(message). With this: O(chunk).
 *
 * Load-bearing invariant (same as `streamFromSegments`): the caller MUST
 * share ONE segment list with `sumSegmentBytes` for the range-clamp math —
 * a second `buildMessageSegments` call would `stat` attachment files a
 * second time and can race the measurement, producing a wire-length
 * disagreement.
 */
export async function* streamPartialFromSegments(
  segments: MessageSegment[],
  start: number,
  length: number
): AsyncGenerator<Buffer, void, unknown> {
  if (length <= 0) return;
  const end = start + length;
  let cumulative = 0;
  for (const segment of segments) {
    if (cumulative >= end) return;
    const segBytes = segmentByteLength(segment);
    const segStart = cumulative;
    const segEnd = cumulative + segBytes;
    cumulative = segEnd;
    if (segEnd <= start) continue;
    const skipInSeg = Math.max(0, start - segStart);
    const takeInSeg = Math.min(segBytes, end - segStart) - skipInSeg;
    if (takeInSeg <= 0) continue;
    // `lazy-text` gets the offset-aware fast path: read pgByteChunks
    // starting at the byte position corresponding to `skipInSeg` in the
    // segment's base64 output, instead of draining the column from
    // position 1 and discarding through `sliceStream`. Cuts partial
    // BODY[] window latency from O(offset) SUBSTRING round-trips to O(1)
    // per window, so iOS's 30s per-command timeout on a multi-MB body
    // full-sync stops firing after the first couple of tail windows
    // (#793 unmasked this: iOS's own follow-up FETCHes for the same
    // large message hit ever-later windows). Other segment kinds still
    // funnel through `sliceStream` — their emitters (`emitLiteral`,
    // `emitBase64`, `emitAttachment`) already yield in bounded chunks
    // from a source that's cheap to re-open per window.
    if (segment.kind === "lazy-text") {
      yield* streamLazyTextPartial(segment, skipInSeg, takeInSeg);
      continue;
    }
    yield* sliceStream(streamOneSegment(segment), skipInSeg, takeInSeg);
  }
}

/**
 * Emit exactly `takeInSeg` base64 bytes starting at `skipInSeg` in a
 * `lazy-text` segment's base64 output. Reads the underlying `text` / `html`
 * column at the byte offset corresponding to the skip position — no drain
 * from position 1 — so each partial-fetch window costs O(len) SUBSTRING
 * calls rather than O(offset+len). See `streamPartialFromSegments`.
 *
 * Alignment invariant: base64 encodes 3 raw bytes into 4 base64 chars, so
 * every 4-base64-char boundary maps to a 3-raw-byte boundary. We start the
 * pgByteChunks reader at the largest 3-byte-aligned raw offset `≤` the
 * skip target and shave off up to 3 leading base64 chars for the last-mile
 * alignment. That's the ONLY overhead vs. a hypothetical "seek to exact
 * base64 byte" reader — and it's bounded to 3 chars regardless of segment
 * size.
 */
async function* streamLazyTextPartial(
  segment: Extract<MessageSegment, { kind: "lazy-text" }>,
  skipInSeg: number,
  takeInSeg: number
): AsyncGenerator<Buffer, void, unknown> {
  // Align skip to the 4-base64-char / 3-raw-byte grid. `alignedSkipBase64`
  // is the base64 position we can seek to exactly; `residualBase64` is
  // how much we still need to trim from the emitted stream to hit the
  // caller's actual skip target.
  const alignedSkipBase64 = Math.floor(skipInSeg / 4) * 4;
  const residualBase64 = skipInSeg - alignedSkipBase64;
  const startRawByte = (alignedSkipBase64 / 4) * 3 + 1; // 1-indexed for PG
  const bytes = pgByteChunks(
    segment.mail_id,
    segment.user_id,
    segment.source,
    startRawByte
  );
  const base64 = emitBase64FromBytes(bytes);
  yield* sliceStream(base64, residualBase64, takeInSeg);
}

/**
 * Stream only the segments after the top-level header block — the payload
 * of `BODY[TEXT]` per RFC 3501 §6.4.5 ("Refers to the text body of the
 * message, omitting the header"). The header literal is tagged
 * `role: "headers"` by `buildMessageSegments`; the emitter skips exactly
 * that one and emits the rest verbatim, so multipart boundaries and
 * per-part MIME headers are preserved. Same peak-chunk bound as
 * `streamFromSegments`.
 *
 * Load-bearing invariant: the caller must share ONE segment list with
 * `sumBodyBytes` for its `{N}` (or with a `pre-length` computed by
 * summing `segmentByteLength(seg)` for the emitted subset).
 */
export async function* streamBodyFromSegments(
  segments: MessageSegment[]
): AsyncGenerator<Buffer, void, unknown> {
  yield* streamFromSegmentList(selectBodySegments(segments));
}

/**
 * The `BODY[TEXT]` subset of a segment list — everything except the header
 * literal. Single source of truth for the predicate: the byte sum, the full
 * stream and the partial stream all select through this, so a partial range
 * can never be clamped against a different subset than the one it walks.
 */
export const selectBodySegments = (segments: MessageSegment[]): MessageSegment[] =>
  segments.filter(
    (segment) => !(segment.kind === "literal" && segment.role === "headers")
  );

/** Byte length of the `BODY[TEXT]` payload — everything except the header literal. */
export const sumBodyBytes = (segments: MessageSegment[]): number =>
  sumSegmentListBytes(selectBodySegments(segments));

/**
 * Stream just the body content segment(s) belonging to RFC 3501 part
 * number `partPath` — the payload of `BODY[<partPath>]` (bare number or
 * `.TEXT` subsection; per this codebase's synthetic-part scheme in
 * `getBodyPart`, both resolve to the same base64 body without the
 * part's MIME headers). Matches `buildMessageSegments`' partPath
 * tagging exactly, so `BODY[1]` on a text-only mail yields the text's
 * base64 segment, `BODY[2]` on a text+html mail yields the html's
 * base64 segment, etc.
 */
export async function* streamPartBodyFromSegments(
  segments: MessageSegment[],
  partPath: string
): AsyncGenerator<Buffer, void, unknown> {
  yield* streamFromSegmentList(selectPartBodySegments(segments, partPath));
}

/** The `BODY[<partPath>]` subset of a segment list. Counterpart of `selectBodySegments`. */
export const selectPartBodySegments = (
  segments: MessageSegment[],
  partPath: string
): MessageSegment[] =>
  segments.filter(
    (segment) => segment.kind !== "literal" && segment.partPath === partPath
  );

/** Byte length of the `BODY[<partPath>]` payload — sum of matching body segments. */
export const sumPartBodyBytes = (
  segments: MessageSegment[],
  partPath: string
): number => sumSegmentListBytes(selectPartBodySegments(segments, partPath));

/**
 * Sum a segment list verbatim — no `WIRE_TRAILER`, unlike `sumSegmentBytes`.
 * The trailer is IMAP framing appended by the non-partial branches, not part
 * of the RFC 2822 serialization a partial range addresses (RFC 3501 §6.4.5).
 */
const sumSegmentListBytes = (segments: MessageSegment[]): number =>
  segments.reduce((acc, segment) => acc + segmentByteLength(segment), 0);

/** Stream an already-selected segment list in order. */
async function* streamFromSegmentList(
  segments: MessageSegment[]
): AsyncGenerator<Buffer, void, unknown> {
  for (const segment of segments) {
    yield* streamOneSegment(segment);
  }
}

/** Stream exactly one segment as `streamFromSegments` would for that kind. */
async function* streamOneSegment(
  segment: MessageSegment
): AsyncGenerator<Buffer, void, unknown> {
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
    case "lazy-text":
      yield* emitBase64(
        pgTextChunks(segment.mail_id, segment.user_id, segment.source)
      );
      break;
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
export const buildFullMessage = (mail: FetchMailInput, docId?: string): string => {
  const parts: string[] = [];
  for (const segment of buildMessageSegments(mail, docId)) {
    switch (segment.kind) {
      case "literal":
        parts.push(segment.value);
        break;
      case "base64":
        parts.push(Buffer.from(segment.source, "utf8").toString("base64"));
        break;
      case "lazy-text":
        // The synchronous materializing path can't drive the pg SUBSTRING
        // reader. Callers that need a materialized full message must load
        // `mail.text` / `mail.html` up front — `getRequestedFields` picks
        // the right shape for each BODY[...] section (TEXT + related keep
        // the strings; FULL uses lazy fields).
        throw new Error(
          "buildFullMessage: cannot materialize a lazy-text segment. " +
            "Caller must project mail.text / mail.html instead of the " +
            "text_octets / html_octets streaming fields."
        );
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
