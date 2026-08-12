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
   * Two paths for the text/html `size` + `lines` fields:
   *  - **Cached** — when the caller projects `text_octets` / `html_octets`
   *    (from `octet_length()`) + `text_line_count` / `html_line_count`
   *    (persisted at INSERT time; see saveMail), the fields are derived
   *    with no string in memory. `size = ceil(octets/3)*4` matches
   *    `Buffer.byteLength(base64(content))` exactly; `lines` reads the
   *    cached value verbatim. This is the OOM-fix path — a bare
   *    `UID FETCH X BODYSTRUCTURE` doesn't materialize text/html at all.
   *  - **Materialized** — when the caller passes `mail.text` / `mail.html`
   *    directly (legacy in-memory shape used by tests + the cache-miss
   *    fallback in fetch-helpers), we base64-encode + split on the string
   *    the same way this function has always done. Semantically identical
   *    to the cached path for any non-empty part.
   */

  const buildTextPart = (
    subtype: "plain" | "html",
    content: string | undefined,
    octets: number | undefined,
    lineCount: number | null | undefined
  ): string => {
    const size = typeof octets === "number"
      ? Math.ceil(octets / 3) * 4
      : Buffer.byteLength(encodeText(content ?? ""), "utf-8");
    const lines = typeof lineCount === "number"
      ? lineCount
      : (content ?? "").split(/\r?\n/).length;

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

    return `(${parts.join(" ")})`;
  };
  const textPart = () =>
    buildTextPart("plain", mail.text, mail.text_octets, mail.text_line_count);
  const htmlPart = () =>
    buildTextPart("html", mail.html, mail.html_octets, mail.html_line_count);

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
      `"BASE64"`, // encoding — quoted string per RFC 3501 §9 body-fld-enc
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

/**
 * Server-defined utility mailboxes: flag-derived views of the user's mail that
 * exist whether or not anything currently matches, the way `Drafts` and `Junk`
 * do on Gmail and Outlook.
 *
 * - `specialUse` is the RFC 6154 attribute LIST reports, so a client can find
 *   each box by role instead of by name.
 * - `placement` is what a write into the box has to set for the row to actually
 *   be in it. These views select by flag, so a COPY / MOVE / APPEND that names
 *   one and does not set the flag would report success and leave the message
 *   nowhere the client can see it.
 * - `uidSpace` picks the UID enumeration:
 *   - `"domain"`: UIDs come from `mails.uid_domain`, and membership is a
 *     predicate over `mails` (`Drafts`, `Junk`). No mapping rows, no counter
 *     rows. Works only for views that resolve to a single value of the `sent`
 *     axis — `mail_uid_counters` keys on `(user_id, uid_kind, uid_scope, sent)`
 *     so two mails with the same `uid_domain` (one sent, one received) collide
 *     in a view that spans both. `Drafts` and `Junk` are both effectively
 *     `sent = false`, so the collision doesn't fire.
 *   - `"mapped"`: UIDs come from `mail_mailbox_uid.uid`, and membership is a
 *     row in `mail_mailbox_uid` keyed on `(user_id, mailbox, mail_id)` — same
 *     shape the per-account `INBOX/accounts/<local>` boxes already use. This
 *     gives the view a UID space of its own, so it works for a view that
 *     spans both `sent = true` and `sent = false`. Used for `Starred` (a mail
 *     may be flagged in either direction) and `Trash` (soft-deletion applies
 *     to sent mail too — see #725).
 *
 *     Mapped-utility rows are populated by the flag-write hooks — a STORE that
 *     flips `saved` inserts the pivot row for `Starred`, a STORE that flips
 *     `deleted` inserts the pivot for `Trash`, and clearing the flag drops the
 *     row. The receive/send paths do the same on initial-flag writes.
 *
 * The matching read-side predicate lives in `repositories/mails/views.ts`,
 * which this module cannot import (the repository is re-exported by the
 * `server` barrel this file pulls from). `views.test.ts` pins the two together.
 */
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

/**
 * Returns true for the mailboxes whose UID space is `uid_domain` rather than
 * the per-mailbox UID (`mail_mailbox_uid.uid`): INBOX, the unified
 * "Sent Messages" folder, and the DOMAIN-SCOPED utility folders (`Drafts`,
 * `Junk`). Mapped-utility folders (`Starred`, `Trash`, #725) join
 * `mail_mailbox_uid` like `INBOX/accounts/<local>` and are NOT included —
 * that's the whole point of separating the two `uidSpace` classes on
 * `UTILITY_FOLDERS`. FETCH / COPY / MOVE / APPEND must gate on this
 * predicate (not `isInbox` alone): the unified Sent folder is domain-scoped
 * too, so keying its emitted UID off the per-mailbox UID makes
 * `uidToSeqNumber` miss (messages silently dropped from FETCH, wrong
 * COPYUID source UIDs). See #702.
 *
 * Not the same question as "does the repository take `null` for this box":
 * a domain-scoped utility folder still passes its name, because that is
 * what its membership predicate is keyed on. `Store.resolveMappedBox` draws
 * that second line.
 */
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
