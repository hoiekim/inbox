import crypto from "crypto";
import { MailType, MailAddressValueType, AttachmentType } from "common";
import { getUserDomain } from "server";
import { logger } from "server";

export const deriveCopyMessageId = (
  sourceMessageId: string | undefined,
  destMailbox: string
): string => {
  // Undefined source Message-ID is a broken source row (mails.message_id
  // is NOT NULL, so this shouldn't reach production paths — but guard
  // anyway). Falling through to the empty-string hash below would make
  // ALL such copies collide on a single derived id; substitute a random
  // seed so each becomes distinct.
  const seed = sourceMessageId ?? crypto.randomBytes(8).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}\0${destMailbox}`)
    .digest("hex")
    .slice(0, 16);
  return `${hash}.copy@server`;
};

export const encodeText = (str: string) => {
  return Buffer.from(str, "utf8").toString("base64");
};

export const headerFieldValue = (value: string): string =>
  value.replace(/[\r\n\0\u2028\u2029]+/g, " ");

export const headerQuotedParam = (value: string): string =>
  `"${headerFieldValue(value).replace(/[\\"]/g, "\\$&")}"`;

/**
 * The `type` and `subtype` halves of a stored `contentType`.
 *
 * Each half falls back on falsiness rather than through a destructuring
 * default, which only fires on `undefined`: `"application"` leaves the subtype
 * undefined, `"/pdf"` leaves the type an empty string, and `"application/"`
 * leaves the subtype empty. A media type missing either half is unparseable,
 * so a client falls back to `text/plain` and renders an attachment inline.
 *
 * BODYSTRUCTURE and the emitted part headers describe the same part, so both
 * derive their media type here — a client comparing them must not be told two
 * different things.
 */
export const mediaTypeParts = (
  contentType?: string
): { type: string; subtype: string } => {
  const [rawType, rawSubtype] = (
    contentType || "application/octet-stream"
  ).split("/");
  return {
    type: rawType || "application",
    subtype: rawSubtype || "octet-stream"
  };
};

/**
 * The `Content-Type` value and quoted `filename` parameter for one attachment
 * part header.
 *
 * The `filename` fallback mirrors `formatBodyStructure`'s (`unnamed`) for the
 * same reason `mediaTypeParts` is shared. Both are `||` fallbacks rather than
 * assertions because `attachments` reaches here straight off the JSONB column
 * with no model hydration, so a row written before a field existed arrives
 * `undefined`.
 *
 * `Attachment`'s constructor (`common/models/mails/Mail.ts`) defaults the same
 * two fields to `text/plain` / `unnamed_file` instead. Those lose because the
 * constructor never runs on this path — `store.ts` casts the JSONB column
 * straight to `AttachmentType[]` with no hydration — and because BODYSTRUCTURE
 * is the value a client cross-checks against. If hydration is ever added to
 * the read path, reconcile the two rather than letting the wire drift.
 */
export const attachmentPartHeaderFields = (
  attachment: Pick<AttachmentType, "contentType" | "filename">
): { contentType: string; filenameParam: string } => {
  const { type, subtype } = mediaTypeParts(attachment.contentType);
  return {
    contentType: headerFieldValue(`${type}/${subtype}`),
    filenameParam: headerQuotedParam(attachment.filename || "unnamed")
  };
};

/**
 * The MIME multipart boundary token derived from a mail's stable id.
 *
 * The id falls back to `mail.messageId` when no `docId` is passed, which puts
 * an attacker-controlled string inside `Content-Type: …; boundary="…"` and
 * inside every `--<boundary>` delimiter. RFC 2046 §5.1.1 `bcharsnospace`
 * admits far less than an arbitrary Message-ID, so map anything outside it to
 * `_`.
 *
 * Character-for-character, so the boundary's CODE-UNIT count never changes.
 * That is not the same as its byte count, and `segmentByteLength` measures
 * bytes: a non-ASCII id shrinks (`café` 5 bytes → 4, `a😀b` 6 → 4). Harmless
 * for a size computed from the same build — `RFC822.SIZE` and the `{N}`
 * literal both derive from one `buildMessageSegments` call — but see the
 * PR body for the persisted `mails.rfc822_size` rows this invalidates.
 */
export const boundaryToken = (stableId: string): string =>
  stableId.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * RFC 3501 §9 quoted string:
 *
 * ```
 * quoted          = DQUOTE *QUOTED-CHAR DQUOTE
 * QUOTED-CHAR     = <any TEXT-CHAR except quoted-specials> / "\" quoted-specials
 * quoted-specials = DQUOTE / "\"
 * TEXT-CHAR       = <any CHAR except CR and LF>
 * ```
 *
 * Two rules, and every value we put on the wire has to satisfy both:
 *
 * 1. `"` and `\` are backslash-escaped. Escaping only `"` is worse than not
 *    escaping at all for a value that *ends* in a backslash: the emitted `\"`
 *    reads as an escaped quote, so the client's parser never terminates the
 *    string and re-terminates on some later opening quote — every remaining
 *    token in that untagged response is mis-framed (#762).
 * 2. CR and LF cannot appear at all, escaped or not. They split the untagged
 *    response into two lines where the client expects one, so the remainder
 *    arrives as an unparseable line and the connection desyncs (#767). They
 *    carry no display meaning here, so each run collapses to a single space.
 *    NUL is outside `CHAR` for the same grammar reason and goes with them.
 *
 * The inputs are attacker-controlled: `receive.ts` stores `message_id`,
 * `subject`, and address display names verbatim from the inbound headers, so
 * an external sender picks these bytes. Route every stored string through
 * here rather than escaping at the call site — partial escaping at four sites
 * is what produced both bugs.
 *
 * Scope note: this enforces the framing rules — the ones whose violation
 * desyncs the connection. It deliberately passes 8-bit octets through, even
 * though `CHAR` is strictly %x01-7F, because the server already emits UTF-8
 * in quoted strings and clients read it. Encoding non-ASCII properly means
 * emitting a literal (or negotiating UTF8=ACCEPT), which is a separate change.
 */
export const quoteString = (value: string): string => {
  const sanitized = value.replace(/[\r\n\0]+/g, " ");
  return `"${sanitized.replace(/[\\"]/g, "\\$&")}"`;
};

/** RFC 3501 §9 `nstring`: a quoted string, or the bare atom `NIL` when absent. */
export const formatNString = (value: string | null | undefined): string =>
  value ? quoteString(value) : "NIL";

export const formatAddressList = (value?: MailAddressValueType[]): string => {
  if (!value || value.length === 0) return "NIL";

  const formatted = value
    .map(({ name = "", address = "" }) => {
      if (!address) return null;

      const [local, domain] = address.split("@");
      if (!local || !domain) return null;

      // RFC 3501 §9: `addr-name = nstring`. A header that carried no display
      // name has no personal name at all — the bare atom NIL, not `""`, which
      // clients read as a present-but-empty name.
      const addrName = formatNString(name);

      return `(${addrName} NIL ${quoteString(local)} ${quoteString(domain)})`;
    })
    .filter((item) => item !== null)
    .join(" ");

  return formatted || "NIL";
};

/**
 * `text` / `html` presence probe that also honors the pg-SUBSTRING
 * streaming shape. In the streaming path the caller passes
 * `text_octets` / `html_octets` (from `octet_length()` at range-read time)
 * instead of the multi-MB column values — a non-zero octet count means the
 * body is non-empty even though the string isn't loaded. Materialized
 * callers still get the `.trim()`-aware check on the actual string.
 */
const hasMaterializedOrLazyBody = (
  raw: string | undefined,
  octets: number | undefined
): boolean =>
  (typeof raw === "string" && raw.trim().length > 0) ||
  (typeof octets === "number" && octets > 0);

export const formatHeaders = (
  mail: Partial<MailType> & { text_octets?: number; html_octets?: number },
  docId?: string
): string => {
  const headers: string[] = [];

  // Add standard headers in proper order
  if (mail.messageId) {
    headers.push(`Message-ID: ${headerFieldValue(mail.messageId)}`);
  }

  if (mail.date) {
    const date = new Date(mail.date);
    headers.push(`Date: ${date.toUTCString()}`);
  }

  if (mail.from?.text) {
    headers.push(`From: ${headerFieldValue(mail.from.text)}`);
  }

  if (mail.to?.text) {
    headers.push(`To: ${headerFieldValue(mail.to.text)}`);
  }

  if (mail.cc?.text) {
    headers.push(`Cc: ${headerFieldValue(mail.cc.text)}`);
  }

  if (mail.bcc?.text) {
    headers.push(`Bcc: ${headerFieldValue(mail.bcc.text)}`);
  }

  if (mail.replyTo?.text) {
    headers.push(`Reply-To: ${headerFieldValue(mail.replyTo.text)}`);
  }

  if (mail.subject) {
    headers.push(`Subject: ${headerFieldValue(mail.subject)}`);
  }

  // Add MIME headers
  headers.push("MIME-Version: 1.0");

  const hasText = hasMaterializedOrLazyBody(mail.text, mail.text_octets);
  const hasHtml = hasMaterializedOrLazyBody(mail.html, mail.html_octets);
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  // Use stable boundary based on docId - docId should always exist
  if (!docId) {
    logger.warn("docId is missing, falling back to messageId", {
      component: "imap",
      messageId: mail.messageId
    });
  }
  const stableId = docId || mail.messageId || "default";

  // Determine Content-Type based on message structure
  if (hasAttachments) {
    // multipart/mixed for messages with attachments
    const boundary = "boundary_" + boundaryToken(stableId);
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  } else if (hasText && hasHtml) {
    // multipart/alternative for messages with both text and HTML
    const boundary = "boundary_" + boundaryToken(stableId);
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  } else if (hasHtml) {
    headers.push("Content-Type: text/html; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
  }

  return headers.join("\r\n");
};

export const formatEnvelope = (mail: Partial<MailType>): string => {
  const date = mail.date ? `"${new Date(mail.date).toUTCString()}"` : "NIL";
  const subject = formatNString(mail.subject);
  const from = formatAddressList(mail.from?.value);
  const sender = from; // Usually same as from
  const replyTo = mail.replyTo ? formatAddressList(mail.replyTo.value) : "NIL";
  const to = formatAddressList(mail.to?.value);
  const cc = formatAddressList(mail.cc?.value);
  const bcc = formatAddressList(mail.bcc?.value);
  const inReplyTo = "NIL"; // Not implemented
  const messageId = formatNString(mail.messageId);

  // RFC 3501 §7.4.2 / §9: each address-list envelope member is either the
  // bare atom `NIL` (its header is absent) or a parenthesized `1*address`
  // list — never `(NIL)`. `formatAddressList` already returns bare "NIL" for
  // an empty/absent list, so only the populated case gets the parentheses.
  const addressList = (list: string) => (list === "NIL" ? "NIL" : `(${list})`);

  return `(${date} ${subject} ${addressList(from)} ${addressList(sender)} ${addressList(replyTo)} ${addressList(to)} ${addressList(cc)} ${addressList(bcc)} ${inReplyTo} ${messageId})`;
};

export const formatBodyStructure = (
  mail: Partial<MailType> & {
    text_octets?: number;
    html_octets?: number;
  },
  extensible = true
): string => {
  /**
   * IMAP BODYSTRUCTURE format:
   * For single part: (type subtype (param-list) id description encoding size [lines] [md5] [disposition] [language] [location])
   * For multipart: ((part1)(part2)...(partN) subtype (param-list) [disposition] [language] [location])
   *
   * The bracketed tail (md5/disposition/language/location on single parts,
   * param-list/disposition/language/location on multiparts) is the extension
   * data — present only in BODYSTRUCTURE. The bare `BODY` data item is the
   * non-extensible form (RFC 3501 §6.4.5): pass extensible=false to drop it.
   *
   * `size` has two paths:
   *  - **Cached** — when the caller projects `text_octets` / `html_octets`
   *    (from `octet_length()`), `size = ceil(octets/3)*4` matches
   *    `Buffer.byteLength(base64(content))` exactly with no string in
   *    memory. This is the OOM-fix path — a bare
   *    `UID FETCH X BODYSTRUCTURE` doesn't materialize text/html at all.
   *  - **Materialized** — when the caller passes `mail.text` / `mail.html`
   *    directly (the in-memory `formatHeaders`-shaped callers and tests), we
   *    base64-encode and measure the string.
   */

  // RFC 3501 §7.4.2: body-fld-lines counts the body in its *transfer
  // encoding*, not the decoded text. Every body this server serves is
  // base64 with no line folding, so it is one line — zero when the part
  // carries no bytes at all.
  const encodedLineCount = (size: number): number => (size === 0 ? 0 : 1);

  const buildTextPart = (
    subtype: "plain" | "html",
    content: string | undefined,
    octets: number | undefined
  ): string => {
    const size =
      typeof octets === "number"
        ? Math.ceil(octets / 3) * 4
        : Buffer.byteLength(encodeText(content ?? ""), "utf-8");
    const lines = encodedLineCount(size);

    // RFC 3501 §9: media-type and media-subtype are `string` (quoted or
    // literal), body-fld-enc is a quoted string too. Bare atoms like
    // `TEXT PLAIN BASE64` break strict client parsers (Apple Mail on iOS
    // ≥ 26 aborts the session mid-response and reconnects).
    const parts = [
      `"TEXT"`,
      `"${subtype.toUpperCase()}"`,
      `("CHARSET" "UTF-8")`,
      "NIL",
      "NIL",
      `"BASE64"`,
      size.toString(),
      lines.toString()
    ];

    if (extensible) {
      parts.push(
        "NIL", // MD5
        "NIL", // disposition
        "NIL", // language
        "NIL" // location
      );
    }

    return `(${parts.join(" ")})`;
  };
  const textPart = () => buildTextPart("plain", mail.text, mail.text_octets);
  const htmlPart = () => buildTextPart("html", mail.html, mail.html_octets);

  const buildAttachmentPart = (attachment: AttachmentType): string => {
    const { type, subtype } = mediaTypeParts(attachment.contentType);
    const filename = attachment.filename || "unnamed";
    // base64 length calculation without actually encoding
    const size = attachment.size ? Math.ceil(attachment.size / 3) * 4 : 0;
    const params: Record<string, string> = { NAME: filename };
    const disposition = { type: "ATTACHMENT", params: { FILENAME: filename } };

    const parts = [
      quoteString(type),
      quoteString(subtype),
      Object.keys(params).length > 0
        ? `(${Object.entries(params)
            .map(([k, v]) => `${quoteString(k)} ${quoteString(v)}`)
            .join(" ")})`
        : "NIL",
      "NIL", // body ID
      "NIL", // body description
      `"BASE64"`, // encoding — quoted string per RFC 3501 §9 body-fld-enc
      size.toString()
    ];

    // RFC 3501 §9: `body-type-text = media-text SP body-fields SP
    // body-fld-lines` — a text/* part carries one field more than
    // body-type-basic, and a parser that dispatches on the media type reads
    // every following field one position early without it.
    if (type.toLowerCase() === "text") {
      parts.push(encodedLineCount(size).toString());
    }

    if (extensible) {
      parts.push(
        "NIL", // MD5
        `(${quoteString(disposition.type)} (${Object.entries(disposition.params)
          .map(([k, v]) => `${quoteString(k)} ${quoteString(v)}`)
          .join(" ")}))`,
        "NIL", // language
        "NIL" // location
      );
    }

    return `(${parts.join(" ")})`;
  };

  // Multipart wrapper tail: `subtype` alone (non-extensible) or `subtype` plus
  // the extension data — body-fld-param, disposition, language, location.
  const multipartTail = (subtype: string): string =>
    extensible ? `"${subtype}" NIL NIL NIL NIL` : `"${subtype}"`;

  // Same materialized-or-lazy shape formatHeaders uses (see
  // hasMaterializedOrLazyBody): in lazy mode the trim() check isn't
  // available so a whitespace-only column reads as has-content (rare
  // real-world). Both paths agree on the has-body decision, which is
  // load-bearing — formatHeaders and formatBodyStructure MUST take the
  // same branch (`multipart/alternative` vs `text/plain`) or the wire
  // response contradicts itself.
  const hasText = hasMaterializedOrLazyBody(mail.text, mail.text_octets);
  const hasHtml = hasMaterializedOrLazyBody(mail.html, mail.html_octets);
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  // Case 1: Single text part (no HTML, no attachments)
  if (hasText && !hasHtml && !hasAttachments) {
    return textPart();
  }

  // Case 2: Single HTML part (no text, no attachments)
  if (!hasText && hasHtml && !hasAttachments) {
    return htmlPart();
  }

  // RFC 3501 §9: `body-type-mpart = 1*body SP media-subtype [SP …]`. Sibling
  // parts CONCATENATE — no separator. The single SP is the sentinel telling
  // the parser "parts done, subtype next." Emitting `(partA) (partB)` breaks
  // parsers that use SP-after-`)` as the parts-done delimiter (Apple Mail).
  // Case 3: Text and HTML (multipart/alternative)
  if (hasText && hasHtml && !hasAttachments) {
    return `(${textPart()}${htmlPart()} ${multipartTail("alternative")})`;
  }

  // Case 4: Content with attachments (multipart/mixed)
  if (hasAttachments) {
    const bodyParts: string[] = [];

    // If we have both text and HTML, create a multipart/alternative first
    if (hasText && hasHtml) {
      const alternativePart = `(${textPart()}${htmlPart()} ${multipartTail(
        "alternative"
      )})`;
      bodyParts.push(alternativePart);
    } else if (hasText) {
      bodyParts.push(textPart());
    } else if (hasHtml) {
      bodyParts.push(htmlPart());
    }

    // Add attachment parts
    mail.attachments!.forEach((attachment) => {
      bodyParts.push(buildAttachmentPart(attachment));
    });

    return `(${bodyParts.join("")} ${multipartTail("mixed")})`;
  }

  // Default case: empty text part (no lazy inputs either, so the
  // materialized shape drives the size — encodeText("") = "", 0 octets).
  return buildTextPart("plain", "", undefined);
};

export const formatFlags = (mail: Partial<MailType>): string[] => {
  const flags: string[] = [];

  if (mail.read) flags.push("\\Seen");
  if (mail.saved) flags.push("\\Flagged");
  if (mail.deleted) flags.push("\\Deleted");
  if (mail.draft) flags.push("\\Draft");
  if (mail.answered) flags.push("\\Answered");

  return flags;
};

export const ACCOUNTS_FOLDER = "INBOX/accounts";
export const SENT_MESSAGES_FOLDER = "Sent Messages";
export const SENT_MESSAGES_ACCOUNTS_FOLDER = `${SENT_MESSAGES_FOLDER}/accounts`;

export type UtilityPlacement = {
  draft?: boolean;
  is_spam?: boolean;
  saved?: boolean;
  deleted?: boolean;
};

export type UtilityUidSpace = "domain" | "mapped";

export const UTILITY_FOLDERS: {
  name: string;
  specialUse: string;
  placement: UtilityPlacement;
  uidSpace: UtilityUidSpace;
}[] = [
  {
    name: "Drafts",
    specialUse: "\\Drafts",
    placement: { draft: true },
    uidSpace: "domain",
  },
  {
    name: "Junk",
    specialUse: "\\Junk",
    placement: { is_spam: true },
    uidSpace: "domain",
  },
  {
    name: "Starred",
    specialUse: "\\Flagged",
    placement: { saved: true },
    uidSpace: "mapped",
  },
  {
    name: "Trash",
    specialUse: "\\Trash",
    placement: { deleted: true },
    uidSpace: "mapped",
  },
];

/**
 * The utility folder `box` names, or `undefined` for any other box.
 *
 * Case-insensitive, like `isInbox` and unlike an exact-match lookup: LIST
 * de-dups user boxes against these names case-insensitively, so an exact-match
 * guard would let `CREATE "drafts"` through into a row that LIST then hides and
 * SELECT then rejects — the phantom `createMailbox`'s guard exists to prevent.
 */
export const utilityFolder = (box: string) =>
  UTILITY_FOLDERS.find((folder) => folder.name.toLowerCase() === box.toLowerCase());

/** Returns true for a server-defined utility mailbox (`Drafts`, `Junk`, `Starred`, `Trash`). */
export const isUtilityFolder = (box: string): boolean => !!utilityFolder(box);

/** Returns true for a utility folder whose UID space is `mail_mailbox_uid.uid`
 * rather than `mails.uid_domain` — i.e. one whose read/write path is the same
 * as the per-account `INBOX/accounts/<local>` boxes and needs a pivot row per
 * membership. Today: `Starred` and `Trash`. */
export const isMappedUtilityFolder = (box: string): boolean =>
  utilityFolder(box)?.uidSpace === "mapped";

/** The flags a mail must carry to land in `box`, or `undefined` for any other box. */
export const utilityPlacement = (box: string): UtilityPlacement | undefined =>
  utilityFolder(box)?.placement;

/**
 * The canonical spelling of a server-defined mailbox name, unchanged for any
 * other box. Every entry point that takes a mailbox name off the wire (SELECT,
 * STATUS, COPY, MOVE, APPEND) has to run it through here: `isInbox` and
 * `utilityFolder` both match case-insensitively, but `mailboxExists` compares
 * against the LIST names exactly, so an un-canonicalized `drafts` is refused by
 * CREATE as already existing and by SELECT as not existing — leaving the client
 * with no legal next command.
 */
export const canonicalMailbox = (box: string): string =>
  isInbox(box) ? "INBOX" : (utilityFolder(box)?.name ?? box);

/** Maps an email address to its received-mail virtual mailbox name. */
export const accountToBox = (accountName: string): string => {
  const localPart = accountName.split("@")[0];
  return `${ACCOUNTS_FOLDER}/${localPart}`;
};

/** Maps an email address to its sent-mail virtual mailbox name. */
export const accountToSentBox = (accountName: string): string => {
  const localPart = accountName.split("@")[0];
  return `${SENT_MESSAGES_ACCOUNTS_FOLDER}/${localPart}`;
};

/**
 * Returns true for any sent mailbox:
 * - "Sent Messages" (unified across all accounts)
 * - "Sent Messages/accounts/{name}" (per-account sent)
 */
export const isSentBox = (box: string): boolean => {
  return box === SENT_MESSAGES_FOLDER || box.startsWith(`${SENT_MESSAGES_ACCOUNTS_FOLDER}/`);
};

/**
 * Returns true for the special INBOX mailbox name. RFC 3501 §5.1 mandates
 * case-insensitive matching for INBOX only ("there is a special name INBOX
 * … in a case-insensitive fashion"); all other mailbox names remain
 * case-sensitive. Every `=== "INBOX"` check in the IMAP layer routes through
 * this helper so the rule lives in one place.
 */
export const isInbox = (box: string): boolean => {
  return box.toUpperCase() === "INBOX";
};

export const isDomainScoped = (box: string): boolean => {
  if (isInbox(box) || box === SENT_MESSAGES_FOLDER) return true;
  const utility = utilityFolder(box);
  return utility?.uidSpace === "domain";
};

/** Returns true for the accounts/ parent folder itself (non-selectable). */
export const isAccountsFolder = (box: string): boolean => {
  return box === ACCOUNTS_FOLDER;
};

/** Returns true for the Sent Messages/accounts/ parent folder itself (non-selectable). */
export const isSentMessagesAccountsFolder = (box: string): boolean => {
  return box === SENT_MESSAGES_ACCOUNTS_FOLDER;
};

export const boxToAccount = (username: string, box: string): string => {
  const domain = getUserDomain(username);
  let localPart = box;
  if (localPart.startsWith(SENT_MESSAGES_ACCOUNTS_FOLDER + "/")) {
    localPart = localPart.slice(SENT_MESSAGES_ACCOUNTS_FOLDER.length + 1);
  } else if (localPart.startsWith(ACCOUNTS_FOLDER + "/")) {
    localPart = localPart.slice(ACCOUNTS_FOLDER.length + 1);
  }
  return `${localPart}@${domain}`;
};

export const formatInternalDate = (d: Date): string => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const pad = (n: number) => String(n).padStart(2, "0");

  // RFC 3501 §9 date-day-fixed: single-digit days are space-padded (" 9"),
  // not zero-padded. Only the day uses this rule; time fields are 2DIGIT.
  const day = String(d.getDate()).padStart(2, " ");
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(pad)
    .join(":");

  const offset = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offset >= 0 ? "+" : "-";
  const tz =
    sign + pad(Math.floor(Math.abs(offset) / 60)) + pad(Math.abs(offset) % 60);

  return `${day}-${month}-${year} ${time} ${tz}`;
};
