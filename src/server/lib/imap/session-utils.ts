/**
 * Utility functions extracted from ImapSession
 * These are pure functions that don't require session state
 */

import { PartialRange, BodySection, FetchDataItem } from "./types";
import { MailType } from "common";
import { formatHeaders } from "./util";

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
      return `BODY[${section.partNumber}]`;
    case "HEADER_FIELDS":
      return section.not ? "BODY[HEADER.FIELDS.NOT]" : "BODY[HEADER.FIELDS]";
    default:
      return "BODY[]";
  }
};

/**
 * Check if any fetch data item should mark message as read
 */
export const shouldMarkAsRead = (dataItems: FetchDataItem[]): boolean => {
  return dataItems.some((item) => item.type === "BODY" && !item.peek);
};

/**
 * Build complete RFC822 message from mail data
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
    return `${headers}\r\n\r\n${mail.text}`;
  }

  if (!hasText && hasHtml && !hasAttachments) {
    return `${headers}\r\n\r\n${mail.html}`;
  }

  // For multipart messages, extract boundary from headers or use deterministic one
  const boundaryMatch = headers.match(/boundary="([^"]+)"/);
  if (!docId) {
    console.warn(
      `[IMAP] Warning: docId is missing in buildFullMessage, falling back to messageId: ${mail.messageId}`
    );
  }
  const stableId = docId || mail.messageId || "default";
  const boundary = boundaryMatch ? boundaryMatch[1] : "boundary_" + stableId;
  let body = "";

  if (hasText && hasHtml && !hasAttachments) {
    // multipart/alternative
    const updatedHeaders = headers.replace(
      /Content-Type: [^\r\n]+/,
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    );

    body = `${updatedHeaders}\r\n\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Type: text/plain; charset=utf-8\r\n`;
    body += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    body += `${mail.text}\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Type: text/html; charset=utf-8\r\n`;
    body += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    body += `${mail.html}\r\n`;
    body += `--${boundary}--\r\n`;
  } else if (hasAttachments) {
    // multipart/mixed
    const updatedHeaders = headers.replace(
      /Content-Type: [^\r\n]+/,
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    );

    body = `${updatedHeaders}\r\n\r\n`;

    // Add text/html parts
    if (hasText && hasHtml) {
      const altBoundary = "alt_" + Date.now();
      body += `--${boundary}\r\n`;
      body += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
      body += `--${altBoundary}\r\n`;
      body += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
      body += `${mail.text}\r\n`;
      body += `--${altBoundary}\r\n`;
      body += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
      body += `${mail.html}\r\n`;
      body += `--${altBoundary}--\r\n`;
    } else if (hasText) {
      body += `--${boundary}\r\n`;
      body += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
      body += `${mail.text}\r\n`;
    } else if (hasHtml) {
      body += `--${boundary}\r\n`;
      body += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
      body += `${mail.html}\r\n`;
    }

    // Add attachments
    mail.attachments?.forEach((att) => {
      body += `--${boundary}\r\n`;
      body += `Content-Type: ${att.contentType}\r\n`;
      body += `Content-Transfer-Encoding: base64\r\n`;
      body += `Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n`;
      body += `${att.content.data}\r\n`;
    });

    body += `--${boundary}--\r\n`;
  }

  return body;
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

  if (!hasAttachments) {
    if (hasText && hasHtml) {
      // multipart/alternative
      if (mainPart === 1) return mail.text || null;
      if (mainPart === 2) return mail.html || null;
    } else if (hasText && mainPart === 1) {
      return mail.text || null;
    } else if (hasHtml && mainPart === 1) {
      return mail.html || null;
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
      if (subPart === 1) return mail.text || null;
      if (subPart === 2) return mail.html || null;
    } else if (hasText) {
      return mail.text || null;
    } else if (hasHtml) {
      return mail.html || null;
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
    return mail.attachments[attachmentIndex].content.data;
  }

  return null;
};
