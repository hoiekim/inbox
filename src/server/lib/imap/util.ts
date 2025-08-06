import { MailType } from "common";
import { getUserDomain } from "server";

export const formatAddressList = (value?: any): string => {
  if (!value) return "NIL";

  const arr = Array.isArray(value) ? value : [value];

  if (arr.length === 0) return "NIL";

  const formatted = arr
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

export const formatHeaders = (mail: any): string => {
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

  // Determine Content-Type based on message structure
  if (hasAttachments) {
    // multipart/mixed for messages with attachments
    const boundary = "boundary_" + Date.now();
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  } else if (hasText && hasHtml) {
    // multipart/alternative for messages with both text and HTML
    const boundary = "boundary_" + Date.now();
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

export const formatEnvelope = (mail: any): string => {
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

  const buildSinglePart = (
    type: string,
    subtype: string,
    content: string,
    params: Record<string, string> = {},
    encoding: string = "8bit",
    disposition?: { type: string; params: Record<string, string> }
  ): string => {
    const size = Buffer.byteLength(content, "utf-8");
    const lines = type === "text" ? content.split(/\r?\n/).length : undefined;
    
    // Build parameter list
    const paramList = Object.keys(params).length > 0 
      ? `(${Object.entries(params).map(([k, v]) => `"${k}" "${v}"`).join(" ")})`
      : "NIL";
    
    // Build disposition
    const dispositionStr = disposition 
      ? `("${disposition.type}" (${Object.entries(disposition.params).map(([k, v]) => `"${k}" "${v}"`).join(" ")}))`
      : "NIL";
    
    const parts = [
      `"${type}"`,
      `"${subtype}"`,
      paramList,
      "NIL", // body ID
      "NIL", // body description
      `"${encoding}"`,
      size.toString()
    ];
    
    if (lines !== undefined) {
      parts.push(lines.toString());
    }
    
    parts.push("NIL"); // MD5
    parts.push(dispositionStr);
    parts.push("NIL"); // language
    parts.push("NIL"); // location
    
    return `(${parts.join(" ")})`;
  };

  const buildTextPart = (subtype: "plain" | "html", content: string): string => {
    return buildSinglePart("text", subtype, content, { charset: "utf-8" });
  };

  const buildAttachmentPart = (attachment: any): string => {
    const [type, subtype] = (attachment.contentType || "application/octet-stream").split("/");
    const filename = attachment.filename || "unnamed";
    const size = attachment.size || 0;
    
    const params: Record<string, string> = {};
    if (filename) {
      params.name = filename;
    }
    
    const disposition = {
      type: "attachment",
      params: { filename }
    };
    
    // For non-text types, don't include line count
    const parts = [
      `"${type}"`,
      `"${subtype}"`,
      Object.keys(params).length > 0 
        ? `(${Object.entries(params).map(([k, v]) => `"${k}" "${v}"`).join(" ")})`
        : "NIL",
      "NIL", // body ID
      "NIL", // body description
      '"base64"', // encoding
      size.toString(),
      "NIL", // MD5
      `("${disposition.type}" (${Object.entries(disposition.params).map(([k, v]) => `"${k}" "${v}"`).join(" ")}))`,
      "NIL", // language
      "NIL"  // location
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
    mail.attachments!.forEach(attachment => {
      bodyParts.push(buildAttachmentPart(attachment));
    });
    
    return `(${bodyParts.join(" ")} "mixed" NIL NIL NIL NIL)`;
  }

  // Default case: empty text part
  return buildTextPart("plain", "");
};

export const escapeImapString = (str: string): string => {
  if (!str) return '""';

  // Check if string needs to be quoted
  if (/[\s\(\)\{\}\%\*\"\\\x00-\x1f\x7f-\xff]/.test(str)) {
    // Escape quotes and backslashes
    const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  return str;
};

export const parseImapString = (str: string): string => {
  if (!str) return "";

  // Remove quotes if present
  if (str.startsWith('"') && str.endsWith('"')) {
    return str.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  return str;
};

export const formatFlags = (mail: any): string[] => {
  const flags: string[] = [];

  if (mail.read) flags.push("\\Seen");
  if (mail.saved) flags.push("\\Flagged");
  if (mail.answered) flags.push("\\Answered");
  if (mail.draft) flags.push("\\Draft");
  if (mail.deleted) flags.push("\\Deleted");

  return flags;
};

export const parseSequenceSet = (sequenceSet: string): number[] => {
  const sequences: number[] = [];
  const parts = sequenceSet.split(",");

  for (const part of parts) {
    if (part.includes(":")) {
      const [startStr, endStr] = part.split(":");
      const start = parseInt(startStr, 10);
      const end =
        endStr === "*" ? Number.MAX_SAFE_INTEGER : parseInt(endStr, 10);

      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) {
          sequences.push(i);
        }
      }
    } else if (part === "*") {
      sequences.push(Number.MAX_SAFE_INTEGER);
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num)) {
        sequences.push(num);
      }
    }
  }

  return sequences.sort((a, b) => a - b);
};

export const accountToBox = (accountName: string): string => {
  return accountName.split("@")[0];
};

export const boxToAccount = (username: string, box: string): string => {
  const isSent = box.startsWith("Sent/");
  const cleanBoxname = isSent ? box.replace("Sent/", "") : box;
  const domain = getUserDomain(username);
  return `${cleanBoxname}@${domain}`;
};
