/**
 * FETCH response building helpers.
 *
 * Pure/near-pure functions that construct IMAP FETCH response parts.
 * These need session context (selectedMailbox, write fn) passed as parameters.
 */

import { MailType } from "common";
import { logger } from "server";
import {
  formatBodyStructure,
  formatEnvelope,
  formatFlags,
  formatHeaders,
  formatInternalDate,
  isDomainScoped,
} from "./util";
import {
  applyPartialFetch,
  buildFullMessage,
  buildMessageSegments,
  computeFullMessageSize,
  streamFromSegments,
  streamPartialFromSegments,
  streamBodyFromSegments,
  streamPartBodyFromSegments,
  sumSegmentBytes,
  sumBodyBytes,
  sumPartBodyBytes,
  WIRE_TRAILER,
  getBodyPart,
  getBodyPartHeaders,
  getBodySectionKey,
} from "./session-utils";
import {
  BodyFetch,
  BodySection,
  FetchDataItem,
} from "./types";
import { withBodyBudget, withBodyBudgetStream } from "./body-budget";
import { withStreamMutex } from "./stream-mutex";
import { updateRfc822Size } from "../postgres/repositories/mails/core";
// `withBodyBudget` gates the small remaining set of paths that still
// materialize before emitting: partial fetches on non-FULL non-header
// sections (BODY[TEXT]<...>, BODY[<part>]<...>), which fall through to
// `getBodyContent` + `applyPartialFetch`. Same RSS scaling concern the
// budget existed to protect against, so same gate.

// ---------------------------------------------------------------------------
// FetchResponsePart types (local to the fetch subsystem)
// ---------------------------------------------------------------------------

// `content` is a string for small parts (headers, simple attributes) and a
// Buffer for the small residual materialized paths (header-like sections,
// partial fetches on non-FULL sections). All large-body paths (FULL,
// TEXT, MIME_PART) emit via `type: "stream"` — see stream-mutex.ts +
// #755 for the per-key mutex that serializes concurrent same-key streams.
//
// **stream** variant: BODY[] / RFC822 for a fetch that streams its bytes
// directly to the socket via `streamFromSegments`, never materializing
// the full body in memory. `length` is pre-computed by `sumSegmentBytes`
// on the SAME segment list (pure math on stored attachment sizes — no
// disk I/O) so the writer can advertise `{N}` before the first chunk
// yields. Sum of yielded chunk byte-lengths equals `length` by
// construction (both derive from the same segment list).
export type FetchResponsePart =
  | { type: "simple"; content: string }
  | { type: "literal"; content: string | Buffer; header: string; length: number }
  | {
      type: "stream";
      stream: AsyncIterable<Buffer>;
      header: string;
      length: number;
    };

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
      // RFC 3501 §6.4.5: a HEADER fetch includes the RFC-2822 delimiting blank
      // line between the header block and the body. `formatHeaders` joins the
      // header lines with `\r\n` and adds no trailing CRLF, so the first `\r\n`
      // terminates the last header line and the second is the delimiting blank
      // line.
      return formatHeaders(mail, docId) + "\r\n\r\n";

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
      // RFC 3501 §6.4.5: `.HEADER`/`.MIME` return the part's MIME header fields;
      // `.TEXT` (and a bare part number) return the part body without them. For
      // this codebase's synthetic parts `getBodyPart` already yields the body
      // sans MIME header, so `.TEXT` and no-subsection resolve identically.
      switch (section.subSection) {
        case "HEADER":
        case "MIME": {
          const headers = getBodyPartHeaders(mail, section.partNumber);
          return headers === null ? null : headers + "\r\n\r\n";
        }
        case "TEXT":
        default:
          return getBodyPart(mail, section.partNumber);
      }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Requested fields
// ---------------------------------------------------------------------------

/**
 * Union of `MailType`'s materialized field names and the four synthetic
 * streaming fields (`text_octets` / `html_octets` / `mail_id` / `user_id`)
 * the BODY[FULL] / RFC822 path adds to drive the pg SUBSTRING body stream.
 * Widening the set type to include these keeps the strings out of Node's
 * heap for large mails while still passing through the store's field-
 * mapping layer unchanged (unknown fields flow through as-is).
 */
export type FetchRequestedField =
  | keyof MailType
  | "text_octets"
  | "html_octets"
  | "mail_id"
  | "user_id";

export function getRequestedFields(dataItems: FetchDataItem[]): Set<FetchRequestedField> {
  const fields = new Set<FetchRequestedField>(["uid"]);

  for (const item of dataItems) {
    switch (item.type) {
      case "ENVELOPE":
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("replyTo");
        fields.add("date");
        fields.add("messageId");
        break;

      case "FLAGS":
        fields.add("read");
        fields.add("saved");
        fields.add("deleted");
        fields.add("draft");
        fields.add("answered");
        break;

      // BODYSTRUCTURE (RFC 3501 §7.4.2) needs `body-fld-octets` for each
      // text/html part. Instead of projecting the multi-MB text/html columns
      // and measuring per-fetch (the last materialization gap after #731 /
      // #739 — spiked RSS on bare `UID FETCH X BODYSTRUCTURE` batches),
      // project the pre-measured `octet_length()` synthetics. `body-fld-lines`
      // needs no projection: it counts the transfer-encoded body, and
      // unfolded base64 is always one line.
      case "BODYSTRUCTURE":
        fields.add("text_octets");
        fields.add("html_octets");
        fields.add("attachments");
        break;

      case "BODY":
        addBodyFields(item, fields);
        break;

      case "INTERNALDATE":
        fields.add("date");
        break;

      // RFC822.SIZE is derived from the full-message serializer (it must equal
      // len(BODY[]) per §2.3.4), so it needs every column that serializer
      // reads — headers included, not just the body parts. Request the same
      // columns a FULL body fetch does. Also request `rfc822_size` (nullable
      // cached column) so the fetch handler can short-circuit — a hit skips
      // buildFullMessage entirely, saving the ~100MB attachment materialization
      // per request (see #729 K836 spike). The body columns stay in the
      // projection for the fallback path (first observation of a mail).
      case "RFC822.SIZE":
        addBodyFields({ type: "BODY", peek: true, section: { type: "FULL" } }, fields);
        fields.add("rfc822_size" as keyof MailType);
        break;

      // RFC822* alias the matching BODY[...] sections (§6.4.5); request the
      // same columns those variants do.
      case "RFC822":
        addBodyFields({ type: "BODY", peek: false, section: { type: "FULL" } }, fields);
        break;

      case "RFC822.HEADER":
        addBodyFields({ type: "BODY", peek: true, section: { type: "HEADER" } }, fields);
        break;

      case "RFC822.TEXT":
        addBodyFields({ type: "BODY", peek: false, section: { type: "TEXT" } }, fields);
        break;
    }
  }

  return fields;
}

export function addBodyFields(
  bodyFetch: BodyFetch,
  fields: Set<FetchRequestedField>
): void {
  switch (bodyFetch.section.type) {
    case "FULL":
      // Both full and partial FULL BODY[] fetches route through the
      // segment-walk streamer (`streamFromSegments` / `streamPartialFromSegments`).
      // The lazy synthetics (`text_octets` / `html_octets` / `mail_id` /
      // `user_id`) let the emitter pull the text/html columns via
      // chunked pg SUBSTRING at emit time instead of materializing the
      // strings up front — peak stays O(chunk) for both variants.
      fields.add("text_octets");
      fields.add("html_octets");
      fields.add("mail_id");
      fields.add("user_id");
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      fields.add("attachments");
      break;

    case "TEXT":
      // BODY[TEXT]: non-partial streams via `streamBodyFromSegments`
      // (segments minus the top-level header literal). Partial TEXT
      // falls through to `getBodyContent → buildFullMessage`, which
      // requires materialized `text` / `html` strings — projecting them
      // keeps partial correct AND makes `.MIME` / `.HEADER` sub-section
      // handling (`getBodyPartHeaders`, which reads `mail.text.trim()`)
      // work. Cost: `wantsLazyBodies` returns false when the strings
      // are present, so `buildMessageSegments` emits `base64` segments
      // instead of `lazy-text` — the non-partial TEXT stream is still
      // chunk-bounded on the output side but `mail.text` / `mail.html`
      // sit in memory for the fetch's duration.
      fields.add("text");
      fields.add("html");
      fields.add("text_octets");
      fields.add("html_octets");
      fields.add("mail_id");
      fields.add("user_id");
      fields.add("attachments");
      // Header context needed for `formatHeaders` (which
      // `buildMessageSegments` calls to emit the multipart boundary +
      // Content-Type declaration inside the body content).
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      break;

    case "HEADER":
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
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
        fields.add("replyTo");
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
      // BODY[<part>]: non-partial bare/.TEXT streams via
      // `streamPartBodyFromSegments` (segment filter by partPath).
      // Partial fetches AND `.MIME` / `.HEADER` sub-sections fall
      // through to `getBodyPart` / `getBodyPartHeaders`, both of
      // which use `mail.text.trim()` to decide part existence.
      // Projecting materialized `text` / `html` keeps those correct.
      // Same trade-off as TEXT: non-partial bare/.TEXT still streams
      // chunk-bounded on output but the source strings sit in memory.
      fields.add("text");
      fields.add("html");
      fields.add("text_octets");
      fields.add("html_octets");
      fields.add("mail_id");
      fields.add("user_id");
      fields.add("attachments");
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      break;
  }
}

// ---------------------------------------------------------------------------
// convertSequenceSet
// ---------------------------------------------------------------------------

export function convertSequenceSet(
  sequenceSet: import("./types").SequenceSet
): { start: number; end: number }[] {
  // RFC 3501 §9: a seq/UID range is order-independent — `3:1` ≡ `1:3`. The
  // wildcard `*` is already expanded to MAX_SAFE_INTEGER by the parser, so
  // normalizing min/max here (the single resolution point shared by FETCH and
  // STORE) covers descending ranges like `3:1`, `5:1`, and `*:1` without the
  // empty `uid >= 3 AND uid <= 1` predicate they would otherwise produce.
  return sequenceSet.ranges.map(({ start, end = start }) => ({
    start: Math.min(start, end),
    end: Math.max(start, end),
  }));
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

// Sections whose `getBodyContent` output already ends in its own delimiting
// blank line, so the builder must not append another trailing CRLF. Covers
// HEADER, HEADER.FIELDS, and a MIME part's `.HEADER`/`.MIME` sub-section.
function isHeaderLikeSection(section: BodySection): boolean {
  return (
    section.type === "HEADER" ||
    section.type === "HEADER_FIELDS" ||
    (section.type === "MIME_PART" &&
      (section.subSection === "HEADER" || section.subSection === "MIME"))
  );
}

export async function buildBodyResponsePart(
  mail: Partial<MailType>,
  bodyFetch: BodyFetch,
  docId: string,
  selectedMailbox: string,
  keyOverride?: string
): Promise<FetchResponsePart | null> {
  void selectedMailbox; // reserved for future per-mailbox logic
  const { section, partial } = bodyFetch;

  // RFC822 / RFC822.HEADER / RFC822.TEXT reuse the BODY[...] builders but must
  // label the response part with the item the client requested.
  const sectionKey = keyOverride ?? getBodySectionKey(section);

  // Non-header-like body sections (FULL, TEXT, bare/`.TEXT` MIME_PART —
  // and partial FULL) take the segment-walk streaming path:
  // `buildMessageSegments` builds the ordered segment list once,
  // `sumSegmentBytes` / `sumBodyBytes` / `sumPartBodyBytes` measure the
  // exact wire byte count (one `stat` per attachment, no reads) so
  // `{N}` is pinned before the first chunk yields, and the appropriate
  // `stream*Segments` generator yields chunk-bounded Buffers to the
  // socket. Peak transient on the output side is O(chunk) for all
  // section variants; for FULL the SOURCE is also chunk-bounded (lazy
  // text/html + attachment reads); for TEXT / MIME_PART the source
  // strings sit in memory for the fetch's duration because the
  // fall-through paths (`.MIME` / `.HEADER`, partial variants) need
  // materialized `mail.text` / `mail.html` for correctness. Completing
  // the lazy migration for those paths is tracked as a follow-up
  // under #757.
  //
  // Cache is deleted (was `body-buffer.ts`): streaming makes it
  // unnecessary. Retention shapes the pre-cache-deletion code returned:
  //  - `getBodyContent` → null: the whole part is dropped from the FETCH
  //    response (e.g. `BODY[99]` on a 2-part message) → still returned
  //    as `null` from `buildBodyResponsePart` for the MIME_PART branch
  //    when `sumPartBodyBytes === 0`.
  //  - `getBodyContent` → "":   emit `<sectionKey> NIL` (e.g.
  //    `BODY[TEXT]` on a mail with no text/html/attachments) → still
  //    returned as a simple NIL when `sumBodyBytes === 0`.
  //  - non-empty: emit a `{N}\r\n<octets>` stream (was: cached literal).
  //
  // Instead, `withStreamMutex(key, ...)` serializes SAME-KEY streams:
  // one iOS-pipelined `UID FETCH X (UID BODY)` on the same UID runs to
  // completion before the next fresh stream for that UID starts. Cuts
  // duplicate PG round-trips + duplicate in-flight chunk buffers under
  // the retry-storm shape without materializing.
  //
  // Still inside the body budget: this is the largest fetch shape, so leaving
  // it uncapped would let K concurrent sockets each stream a distinct large
  // body while the budget covered only the cheaper paths. The slot is held for
  // the stream's whole lifetime and released even if the consumer abandons it.
  if (!isHeaderLikeSection(section) && section.type === "FULL") {
    // Build the segment list ONCE — reproducing it inside the stream
    // would `stat` attachment files a second time, and a file whose size
    // changed between calls (upload-in-progress, mid-write race, etc.)
    // would make `{N}` disagree with the emitted octets — the exact
    // #733 reviewoie HIGH ("declared 1833, emitted 67165"). Sharing one
    // segment list between the size measurement and the stream is what
    // makes `{N}` byte-exact by construction.
    //
    // The wire response ends with a CRLF after the body serialization,
    // which `sumSegmentBytes` counts (via WIRE_TRAILER), so the stream
    // must emit it too.
    const segments = buildMessageSegments(mail, docId);
    // `sumSegmentBytes` includes the 2-byte wire trailer (`\r\n`) that the
    // non-partial FULL branch appends after streaming the segments. RFC
    // 3501 §6.4.5 partial fetches address bytes of the RFC 2822
    // serialization only — the wire trailer is IMAP framing, not part of
    // the message. Using the trailer-inclusive total for the partial
    // range would let `<0.total>` (or any range that reaches the end)
    // advertise 2 more bytes than `streamPartialFromSegments` actually
    // emits — a wire desync where the next tagged response's leading
    // bytes get consumed as body.
    const totalBodyLength = sumSegmentBytes(segments);
    const partialAddressableBytes = totalBodyLength - WIRE_TRAILER;
    // Acquire the per-key mutex OUTSIDE the byte-budget so a queued
    // same-key waiter doesn't pin a byte-slot while it waits. When it
    // owns the key, it then acquires the byte budget for its stream.
    const streamKey = `${docId}::${sectionKey}`;
    if (partial) {
      // RFC 3501 §6.4.5: `BODY[]<start.length>` returns bytes
      // [start, start+length) of the RFC 2822 serialization. When
      // `start >= partialAddressableBytes` return NIL — the octet range is
      // vacuous. Otherwise clamp `length` to what's actually available
      // so the `{N}` literal advertises the true emitted count.
      const { start, length: requestedLength } = partial;
      if (start >= partialAddressableBytes) {
        return { type: "simple", content: `${sectionKey} NIL` };
      }
      const emittedLength = Math.min(
        requestedLength,
        partialAddressableBytes - start
      );
      const partialStream = withStreamMutex(streamKey, () =>
        withBodyBudgetStream(async function* () {
          yield* streamPartialFromSegments(segments, start, emittedLength);
        })
      );
      // The origin-octet header form is `BODY[<section>]<start>` per
      // §7.4.2 msg-att-static — no length echo; the `{N}` literal
      // already carries the count.
      return {
        type: "stream",
        stream: partialStream,
        header: `${sectionKey}<${start}>`,
        length: emittedLength,
      };
    }
    const stream = withStreamMutex(streamKey, () =>
      withBodyBudgetStream(async function* () {
        yield* streamFromSegments(segments);
        yield Buffer.from("\r\n", "utf8");
      })
    );
    return {
      type: "stream",
      stream,
      header: sectionKey,
      length: totalBodyLength,
    };
  }

  if (!partial && !isHeaderLikeSection(section) && section.type === "TEXT") {
    // BODY[TEXT] — RFC 3501 §6.4.5 "text body of the message, omitting
    // the header." Streamed by walking the segments and skipping the
    // top-level header literal, then appending the same one-CRLF wire
    // trailer the pre-cache-deletion path did (`raw + "\r\n"`). Output
    // stays chunk-bounded via `emitBase64`; the SOURCE is
    // `mail.text` / `mail.html` held in memory (`addBodyFields` projects
    // both materialized + lazy, and `wantsLazyBodies` returns false
    // when strings are present, so segments are `base64`-kind not
    // `lazy-text`). FULL still uses lazy synthetics — peak per FULL
    // fetch is O(chunk), TEXT is O(sizeof(mail.text) + sizeof(mail.html))
    // + O(chunk).
    const segments = buildMessageSegments(mail, docId);
    const bodyBytes = sumBodyBytes(segments);
    if (bodyBytes === 0) {
      return { type: "simple", content: `${sectionKey} NIL` };
    }
    const streamKey = `${docId}::${sectionKey}`;
    const stream = withStreamMutex(streamKey, () =>
      withBodyBudgetStream(async function* () {
        yield* streamBodyFromSegments(segments);
        yield Buffer.from("\r\n", "utf8");
      })
    );
    return {
      type: "stream",
      stream,
      header: sectionKey,
      length: bodyBytes + WIRE_TRAILER,
    };
  }

  if (!partial && !isHeaderLikeSection(section) && section.type === "MIME_PART") {
    // BODY[<part>] — RFC 3501 §6.4.5. `.HEADER` / `.MIME` return the
    // part's MIME header block (materialized, cheap — see the
    // header-like fallthrough below via `getBodyContent`). Bare number
    // and `.TEXT` both return the part's body base64-encoded; in this
    // codebase's synthetic-part scheme (see `getBodyPart`) they
    // resolve identically. Streamed via the same segment walker,
    // filtered to the requested partPath.
    const subSection = section.subSection;
    if (subSection === "HEADER" || subSection === "MIME") {
      // Fall through to the materialized path below — the part MIME
      // header block is small and cheap.
    } else {
      const partPath = section.partNumber;
      const segments = buildMessageSegments(mail, docId);
      const partBytes = sumPartBodyBytes(segments, partPath);
      if (partBytes === 0) {
        // `buildMessageSegments` only pushes a body segment when the
        // source has non-empty content (`hasText`/`hasHtml`/attachment
        // count > 0), so `partBytes === 0` means the requested part
        // doesn't exist in this mail's structure — matches the old
        // `getBodyPart(...) === null` → `kind: "omit"` → return null
        // behavior. Empty-body-of-existing-part is unreachable here.
        return null;
      }
      const streamKey = `${docId}::${sectionKey}`;
      const stream = withStreamMutex(streamKey, () =>
        withBodyBudgetStream(async function* () {
          yield* streamPartBodyFromSegments(segments, partPath);
          yield Buffer.from("\r\n", "utf8");
        })
      );
      return {
        type: "stream",
        stream,
        header: sectionKey,
        length: partBytes + WIRE_TRAILER,
      };
    }
  }

  // Partial fetch (`BODY[]<start.length>`) and header-like sections
  // (`BODY[HEADER.FIELDS ...]`) fall through here. Partial STILL
  // materializes the full body via `buildFullMessage` before slicing
  // in `applyPartialFetch`, so the RSS scaling concern is the same as
  // the shared-body path — gate through the budget. Header-like
  // sections are cheap (≤ a few KiB) and don't need gating; hop over
  // them with an immediate acquire/release by only gating when the
  // request is a partial.
  const content = partial
    ? await withBodyBudget(() => Promise.resolve(getBodyContent(mail, section, docId)))
    : getBodyContent(mail, section, docId);
  if (content === null) {
    return null;
  }

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
    // Response partial marker is the single origin octet only — RFC 3501 §9
    // `msg-att-static` / §7.4.2 allow `"BODY" section ["<" number ">"]`. The
    // `<start.length>` form is request-only grammar (`fetch-att`); echoing the
    // length back is non-conformant. The `{length}` literal already tells the
    // client how many octets follow.
    header += `<${start}>`;
    // A partial fetch returns exactly the requested substring — no trailing
    // CRLF. (The non-partial branch below appends one and recounts `length`;
    // doing that here would emit 2 octets more than the `{length}` literal
    // advertises, desyncing clients that read exactly `length` octets.)
  }
  // (Non-partial, non-header-like branch is handled by the cached fast
  // path above and returns before reaching here.)

  return { type: "literal", content: finalContent, header, length };
}

/**
 * A mail row that may carry the four synthetic streaming/measurement
 * fields the getMailsByRange projection can add alongside the real
 * MailModel columns: `text_octets` / `html_octets` (pre-measured
 * `octet_length()` for the pg SUBSTRING body stream in BODY[] / RFC822,
 * and for the BODYSTRUCTURE cached-size path here) + `mail_id` / `user_id`
 * (identity for the same stream). Widening the fetch handler's input to
 * this shape lets `BODYSTRUCTURE` read the octet count without a runtime
 * cast at every access site.
 */
export type FetchMailInput = Partial<MailType> & {
  text_octets?: number;
  html_octets?: number;
  mail_id?: string;
  user_id?: string;
};

export async function buildFetchResponsePart(
  mail: FetchMailInput,
  item: FetchDataItem,
  docId: string,
  selectedMailbox: string,
  userId?: string
): Promise<FetchResponsePart | null> {
  switch (item.type) {
    case "UID": {
      const isDomainScopedBox = isDomainScoped(selectedMailbox);
      const uid = isDomainScopedBox ? mail.uid!.domain : mail.uid!.account;
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
      // RFC 3501 §2.3.4: RFC822.SIZE is the octet count of the message in RFC
      // 2822 format — i.e. it must equal the number of octets BODY[] / RFC822
      // returns for the same message.
      //
      // Three-path resolution:
      //  1. **Cached column hit** — `mails.rfc822_size` is a nullable BIGINT
      //     stamped on first observation (#731). When present, return it
      //     verbatim: zero work.
      //  2. **Compute + persist** — for mails that haven't been observed
      //     yet, derive via `computeFullMessageSize` (pure math on stored
      //     attachment sizes — no disk read, no body materialization). The
      //     value equals `Buffer.byteLength(streamFromSegments output)`
      //     by construction so it agrees with what BODY[] would emit.
      //     Fire-and-forget UPDATE persists the value for next time.
      //     Derived without materializing the body, which is the point: a
      //     BODY[] build just to read its length is a multi-MB allocation.
      if (typeof mail.rfc822_size === "number") {
        return { type: "simple", content: `RFC822.SIZE ${mail.rfc822_size}` };
      }
      const size = computeFullMessageSize(mail, docId);
      // Persist for future requests. `userId` is threaded from the top-level
      // FETCH handler; callers without a userId (unit-test / internal)
      // skip the persist step silently. Fire-and-forget — a persist
      // failure surfaces as a log line and the same fetch re-computes
      // next time; nothing is broken.
      if (userId) {
        void updateRfc822Size(userId, docId, size).catch((err) => {
          logger.warn("Failed to persist rfc822_size", {
            component: "imap.fetch",
            mail_id: docId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return { type: "simple", content: `RFC822.SIZE ${size}` };
    }

    case "ENVELOPE": {
      const envelope = formatEnvelope(mail);
      return { type: "simple", content: `ENVELOPE ${envelope}` };
    }

    case "BODYSTRUCTURE": {
      // extensible=false is the bare `BODY` data item: non-extensible structure
      // labelled `BODY` (RFC 3501 §6.4.5). extensible=true is full BODYSTRUCTURE.
      //
      // Metadata-only: the projection carries `text_octets` + `html_octets`
      // (from `octet_length()`), which is everything formatBodyStructure needs.
      // No text/html string is ever loaded, on any row.
      const bodyStructure = formatBodyStructure(mail, item.extensible);
      const label = item.extensible ? "BODYSTRUCTURE" : "BODY";
      return { type: "simple", content: `${label} ${bodyStructure}` };
    }

    case "BODY":
      return buildBodyResponsePart(mail, item, docId, selectedMailbox);

    // RFC 3501 §6.4.5 aliases: RFC822 ≡ BODY[], RFC822.HEADER ≡ BODY[HEADER],
    // RFC822.TEXT ≡ BODY[TEXT]. Delegate to the BODY[...] builders, keeping the
    // RFC822* label on the response part.
    case "RFC822":
      return buildBodyResponsePart(
        mail,
        { type: "BODY", peek: false, section: { type: "FULL" } },
        docId,
        selectedMailbox,
        "RFC822"
      );

    case "RFC822.HEADER":
      return buildBodyResponsePart(
        mail,
        { type: "BODY", peek: true, section: { type: "HEADER" } },
        docId,
        selectedMailbox,
        "RFC822.HEADER"
      );

    case "RFC822.TEXT":
      return buildBodyResponsePart(
        mail,
        { type: "BODY", peek: false, section: { type: "TEXT" } },
        docId,
        selectedMailbox,
        "RFC822.TEXT"
      );

    default:
      return null;
  }
}

export async function buildFetchResponse(
  mail: FetchMailInput,
  dataItems: FetchDataItem[],
  docId: string,
  uid: number,
  isUidFetch: boolean,
  selectedMailbox: string,
  condstoreEnabled: boolean = false,
  userId?: string
): Promise<FetchResponsePart[]> {
  const parts: FetchResponsePart[] = [];

  if (isUidFetch) {
    parts.push({ type: "simple", content: `UID ${uid}` });
  }

  for (const item of dataItems) {
    if (item.type === "UID" && isUidFetch) continue;
    // MODSEQ is emitted once, centrally (below), so the per-item loop skips it —
    // this dedups an explicit `(MODSEQ)` request against the implicit
    // post-ENABLE emission and keeps a single `MODSEQ (n)` in the response.
    if (item.type === "MODSEQ") continue;
    const part = await buildFetchResponsePart(mail, item, docId, selectedMailbox, userId);
    if (part) parts.push(part);
  }

  // RFC 4551 §3.3.2: include MODSEQ when the client asked for it explicitly, or
  // implicitly on every FETCH response once CONDSTORE is enabled. The value is
  // parenthesized (`MODSEQ (n)`) per the msg-att-dynamic grammar.
  const modseqRequested = dataItems.some((item) => item.type === "MODSEQ");
  if ((condstoreEnabled || modseqRequested) && mail.modseq !== undefined) {
    parts.push({ type: "simple", content: `MODSEQ (${mail.modseq})` });
  }

  return parts;
}

/**
 * Async writer for large payloads with socket-level backpressure. Called
 * for `literal` parts whose `content` is a `Buffer` (the residual
 * materialized paths — header-like sections, partial non-FULL sections).
 * Chunks the write so V8 doesn't hold the whole payload in an outbound
 * queue simultaneously, and awaits `drain` when `socket.write` reports
 * back-pressure. `writeChunked` returning without an error means the
 * payload is drained to the OS.
 */
export type WriteChunked = (payload: Buffer) => Promise<void>;

/**
 * Consume an async iterable of chunks and write each to the socket with
 * backpressure. Called for `stream` parts (BODY[] / RFC822 fetches wired
 * through `streamFromSegments`). Peak in-flight allocation stays at
 * one chunk (~64 KiB) — no full-body Buffer is ever materialized.
 */
export type WriteStream = (chunks: AsyncIterable<Buffer>) => Promise<void>;

export async function writeFetchResponse(
  write: (data: string) => boolean | undefined,
  writeChunked: WriteChunked,
  writeStream: WriteStream,
  seqNum: number,
  parts: FetchResponsePart[]
): Promise<void> {
  write(`* ${seqNum} FETCH (`);

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) write(" ");

    const part = parts[i];
    if (part.type === "literal") {
      write(`${part.header} {${part.length}}\r\n`);
      // Buffer content flows through the chunked writer with drain
      // awareness; string content stays on the fast synchronous path.
      if (Buffer.isBuffer(part.content)) {
        await writeChunked(part.content);
      } else {
        write(part.content);
      }
    } else if (part.type === "stream") {
      // {N} literal advertises the sum of upcoming chunk byte-lengths
      // (guaranteed by `computeFullMessageSize` matching the stream's
      // emit-set), then the generator's chunks flow through the
      // stream writer with backpressure.
      write(`${part.header} {${part.length}}\r\n`);
      await writeStream(part.stream);
    } else {
      write(part.content);
    }
  }

  write(")\r\n");
}
