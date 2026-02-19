import { MailType, MailAddressValueType, AttachmentType } from "common";
import { getAttachment, getUserDomain } from "server";

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

      // Escape quotes in name
      const escapedName = name.replace(/"/g, '\\"');

      return `("${escapedName}" NIL "${local}" "${domain}")`;
    })
    .filter((item) => item !== null)
    .join(" ");

  return formatted || "NIL";
};

export const formatHeaders = (
  mail: Partial<MailType>,
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

  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  // Use stable boundary based on docId - docId should always exist
  if (!docId) {
    console.warn(
      `[IMAP] Warning: docId is missing, falling back to messageId: ${mail.messageId}`
    );
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
    headers.push("Content-Transfer-Encoding: 8bit");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: 8bit");
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

  return `(${date} ${subject} (${from}) (${sender}) (${replyTo}) (${to}) (${cc}) (${bcc}) ${inReplyTo} ${messageId})`;
};

export const formatBodyStructure = (mail: Partial<MailType>): string => {
  /**
   * IMAP BODYSTRUCTURE format:
   * For single part: (type subtype (param-list) id description encoding size [lines] [md5] [disposition] [language] [location])
   * For multipart: ((part1)(part2)...(partN) subtype (param-list) [disposition] [language] [location])
   */

  const buildTextPart = (
    subtype: "plain" | "html",
    content: string
  ): string => {
    const encoded = encodeText(content);
    const size = Buffer.byteLength(encoded, "utf-8");
    const lines = content.split(/\r?\n/).length;

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

    return `(${parts.join(" ")})`;
  };

  const buildAttachmentPart = (attachment: AttachmentType): string => {
    const [type, subtype] = (
      attachment.contentType || "application/octet-stream"
    ).split("/");
    const filename = attachment.filename || "unnamed";
    // base64 length calculation without actually encoding
    const size = Math.ceil(attachment.size / 3) * 4;
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
      size.toString(),
      "NIL", // MD5
      `("${disposition.type}" (${Object.entries(disposition.params)
        .map(([k, v]) => `"${k}" "${v}"`)
        .join(" ")}))`,
      "NIL", // language
      "NIL" // location
    ];

    return `(${parts.join(" ")})`;
  };

  const hasText = mail.text && mail.text.trim().length > 0;
  const hasHtml = mail.html && mail.html.trim().length > 0;
  const hasAttachments = mail.attachments && mail.attachments.length > 0;

  // Case 1: Single text part (no HTML, no attachments)
  if (hasText && !hasHtml && !hasAttachments) {
    return buildTextPart("plain", mail.text!);
  }

  // Case 2: Single HTML part (no text, no attachments)
  if (!hasText && hasHtml && !hasAttachments) {
    return buildTextPart("html", mail.html!);
  }

  // Case 3: Text and HTML (multipart/alternative)
  if (hasText && hasHtml && !hasAttachments) {
    const textPart = buildTextPart("plain", mail.text!);
    const htmlPart = buildTextPart("html", mail.html!);
    return `(${textPart} ${htmlPart} "alternative" NIL NIL NIL NIL)`;
  }

  // Case 4: Content with attachments (multipart/mixed)
  if (hasAttachments) {
    const bodyParts: string[] = [];

    // If we have both text and HTML, create a multipart/alternative first
    if (hasText && hasHtml) {
      const textPart = buildTextPart("plain", mail.text!);
      const htmlPart = buildTextPart("html", mail.html!);
      const alternativePart = `(${textPart} ${htmlPart} "alternative" NIL NIL NIL NIL)`;
      bodyParts.push(alternativePart);
    } else if (hasText) {
      bodyParts.push(buildTextPart("plain", mail.text!));
    } else if (hasHtml) {
      bodyParts.push(buildTextPart("html", mail.html!));
    }

    // Add attachment parts
    mail.attachments!.forEach((attachment) => {
      bodyParts.push(buildAttachmentPart(attachment));
    });

    return `(${bodyParts.join(" ")} "mixed" NIL NIL NIL NIL)`;
  }

  // Default case: empty text part
  return buildTextPart("plain", "");
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

export const accountToBox = (accountName: string): string => {
  return accountName.split("@")[0];
};

export const boxToAccount = (username: string, box: string): string => {
  const cleanBoxname = box.replace("Sent Messages/", "").replace("INBOX/", "");
  const domain = getUserDomain(username);
  return `${cleanBoxname}@${domain}`;
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

  const day = pad(d.getDate());
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
