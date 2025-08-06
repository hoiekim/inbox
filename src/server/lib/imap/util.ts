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

  if (mail.html && mail.text) {
    headers.push('Content-Type: multipart/alternative; boundary="boundary123"');
  } else if (mail.html) {
    headers.push("Content-Type: text/html; charset=utf-8");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
  }

  headers.push("Content-Transfer-Encoding: 8bit");

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

export const formatBodyStructure = (mail: any): string => {
  // Simple body structure for text/html emails
  if (mail.html && mail.text) {
    // Multipart/alternative
    return '(("text" "plain" ("charset" "utf-8") NIL NIL "8bit" 0 0)("text" "html" ("charset" "utf-8") NIL NIL "8bit" 0 0) "alternative")';
  } else if (mail.html) {
    // Single HTML part
    return '("text" "html" ("charset" "utf-8") NIL NIL "8bit" 0 0)';
  } else {
    // Single text part
    return '("text" "plain" ("charset" "utf-8") NIL NIL "8bit" 0 0)';
  }
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
