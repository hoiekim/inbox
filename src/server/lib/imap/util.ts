import crypto from "crypto";
import { MailType, MailAddressValueType, AttachmentType } from "common";
import { getUserDomain } from "server";
import { logger } from "server";

/**
 * Deterministic Message-ID for a COPY/MOVE destination row, derived from the
 * source Message-ID + destination mailbox path. Two properties matter:
 *
 * 1. **Retry idempotency.** If a multi-mail COPY/MOVE partially fails (iteration
 *    K writes the `mails` row but `writeMailboxUid` throws), the client's retry
 *    of the same command re-derives the same message-id for each iteration →
 *    `saveMail`'s `UNIQUE(user_id, message_id)` 23505 branch fires → the retry
 *    merges into the row from the first attempt instead of inserting a
 *    duplicate. Without this, every retry-loop iteration draws a fresh random
 *    id (`getRandomId()`), 23505 never fires, iterations 0..K-1 land as new
 *    rows → destination shows duplicates. Filed as hoiekim/inbox#721.
 *
 * 2. **RFC compliance.** RFC 3501 §6.4.7 doesn't require preserving the source
 *    Message-ID across COPY — the destination row is a server-storage
 *    representation, not a re-delivered RFC 5322 message. A deterministic
 *    derived id is as legal as a fresh random one.
 *
 * SHA-256 truncated to 16 hex chars (64 bits) gives collision-safety far above
 * the working-set size (n=2^32 mails per user before ~1% collision probability).
 * The `.copy@` suffix + input separator `\0` avoid accidental collision with
 * external Message-IDs and prevent length-extension edge cases.
 */
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
      const addrName = name ? `"${name.replace(/"/g, '\\"')}"` : "NIL";

      return `(${addrName} NIL "${local}" "${domain}")`;
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
    headers.push(`Message-ID: ${mail.messageId}`);
  }

  if (mail.date) {
    const date = new Date(mail.date);
    headers.push(`Date: ${date.toUTCString()}`);
  }

  if (mail.from?.text) {
    headers.push(`From: ${mail.from.text}`);
  }

  if (mail.to?.text) {
    headers.push(`To: ${mail.to.text}`);
  }

  if (mail.cc?.text) {
    headers.push(`Cc: ${mail.cc.text}`);
  }

  if (mail.bcc?.text) {
    headers.push(`Bcc: ${mail.bcc.text}`);
  }

  if (mail.replyTo?.text) {
    headers.push(`Reply-To: ${mail.replyTo.text}`);
  }

  if (mail.subject) {
    headers.push(`Subject: ${mail.subject}`);
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
    const boundary = "boundary_" + stableId;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  } else if (hasText && hasHtml) {
    // multipart/alternative for messages with both text and HTML
    const boundary = "boundary_" + stableId;
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
  const subject = mail.subject
    ? `"${mail.subject.replace(/"/g, '\\"')}"`
    : "NIL";
  const from = formatAddressList(mail.from?.value);
  const sender = from; // Usually same as from
  const replyTo = mail.replyTo ? formatAddressList(mail.replyTo.value) : "NIL";
  const to = formatAddressList(mail.to?.value);
  const cc = formatAddressList(mail.cc?.value);
  const bcc = formatAddressList(mail.bcc?.value);
  const inReplyTo = "NIL"; // Not implemented
  const messageId = mail.messageId ? `"${mail.messageId}"` : "NIL";

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
   *    directly (legacy in-memory shape used by tests + the cache-miss
   *    fallback in fetch-helpers), we base64-encode and measure the string.
   */

  const buildTextPart = (
    subtype: "plain" | "html",
    content: string | undefined,
    octets: number | undefined
  ): string => {
    const size =
      typeof octets === "number"
        ? Math.ceil(octets / 3) * 4
        : Buffer.byteLength(encodeText(content ?? ""), "utf-8");
    // RFC 3501 §7.4.2: body-fld-lines, like body-fld-octets, measures the body
    // *in its transfer encoding* — the bytes `BODY[n]` serves, not the decoded
    // text. `encodeText` emits unfolded base64, so a text part is exactly one
    // line on both paths. Folding base64 at 76 columns (RFC 2045 §6.8) would
    // make this a real count; that change is tracked in #751.
    const lines = 1;

    const parts = [
      "TEXT",
      subtype.toUpperCase(),
      `("CHARSET" "UTF-8")`,
      "NIL",
      "NIL",
      "BASE64",
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
    const [type, subtype] = (
      attachment.contentType || "application/octet-stream"
    ).split("/");
    const filename = attachment.filename || "unnamed";
    // base64 length calculation without actually encoding
    const size = attachment.size ? Math.ceil(attachment.size / 3) * 4 : 0;
    const params: Record<string, string> = { NAME: filename };
    const disposition = { type: "ATTACHMENT", params: { FILENAME: filename } };

    const parts = [
      `"${type}"`,
      `"${subtype}"`,
      Object.keys(params).length > 0
        ? `(${Object.entries(params)
            .map(([k, v]) => `"${k}" "${v}"`)
            .join(" ")})`
        : "NIL",
      "NIL", // body ID
      "NIL", // body description
      "BASE64", // encoding
      size.toString()
    ];

    if (extensible) {
      parts.push(
        "NIL", // MD5
        `("${disposition.type}" (${Object.entries(disposition.params)
          .map(([k, v]) => `"${k}" "${v}"`)
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

  // Case 3: Text and HTML (multipart/alternative)
  if (hasText && hasHtml && !hasAttachments) {
    return `(${textPart()} ${htmlPart()} ${multipartTail("alternative")})`;
  }

  // Case 4: Content with attachments (multipart/mixed)
  if (hasAttachments) {
    const bodyParts: string[] = [];

    // If we have both text and HTML, create a multipart/alternative first
    if (hasText && hasHtml) {
      const alternativePart = `(${textPart()} ${htmlPart()} ${multipartTail(
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

    return `(${bodyParts.join(" ")} ${multipartTail("mixed")})`;
  }

  // Default case: empty text part (no lazy inputs either, so the
  // materialized shape drives the count — split("") = [""], length 1).
  return buildTextPart("plain", "", undefined, undefined);
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

/**
 * Returns true for the domain-scoped mailboxes — INBOX and the unified
 * "Sent Messages" folder — whose UID space is `uid_domain` rather than
 * the per-mailbox UID (`mail_mailbox_uid.uid`). This mirrors both
 * `Store.resolveBox` and `resolveMappedBox` — the former returns
 * `accountName === null`, the latter returns `mailboxArg === null` for
 * exactly these two paths. FETCH / COPY / MOVE / APPEND must gate on this
 * predicate (not `isInbox` alone): the unified Sent folder is domain-scoped
 * too, so keying its emitted UID off the per-mailbox UID makes
 * `uidToSeqNumber` miss (messages silently dropped from FETCH, wrong
 * COPYUID source UIDs). See #702.
 */
export const isDomainScoped = (box: string): boolean => {
  return isInbox(box) || box === SENT_MESSAGES_FOLDER;
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
  // Strip Sent Messages/accounts/ or accounts/ prefix to extract the local part
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
