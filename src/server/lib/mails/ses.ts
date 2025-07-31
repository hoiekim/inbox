// Not tested. DO NOT USE YET.

import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { MailDataToSend } from "common";
import { UploadedFileDynamicArray } from "./send";
import { getText, getUserDomain } from "server";

const ses = new SESClient({ region: "us-west-2" });

const encodeBase64 = (data: Buffer | string): string => {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return buffer.toString("base64");
};

const getAttachments = (files?: UploadedFileDynamicArray) => {
  const noFiles = Array.isArray(files) ? !files.length : !files;
  if (noFiles) return undefined;

  if (Array.isArray(files)) return files;
  else if (files) return [files];
};

const getMimeMail = (
  username: string,
  mail: MailDataToSend,
  files?: UploadedFileDynamicArray
): string => {
  const { sender, senderFullName, to, cc, bcc, subject, html, inReplyTo } =
    mail;
  const userDomain = getUserDomain(username);
  const from = `${senderFullName} <${sender}@${userDomain}>`;
  const mixedBoundary = `mixed-${Date.now()}`;
  const altBoundary = `alt-${Date.now()}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    ...(inReplyTo
      ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`]
      : []),
    ``
  ];

  const parts: string[] = [];

  const text = getText(html);
  parts.push(
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    ``,
    // text part
    `--${altBoundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    ``,
    // html part
    `--${altBoundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    mail.html,
    ``,
    `--${altBoundary}--`
  );

  // Attachments
  const attachments = getAttachments(files);
  if (attachments) {
    for (const attachment of attachments) {
      const filename = attachment.name || "unknown";
      const contentType = attachment.mimetype || "application/octet-stream";
      const base64Content = encodeBase64(attachment.data);

      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: ${contentType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        base64Content
      );
    }
  }

  // End boundary
  parts.push(`--${mixedBoundary}--`, ``);

  return headers.concat(parts).join("\r\n");
};

/**
 * Not tested. DO NOT USE YET.
 */
const sendSesEmail = async (
  username: string,
  mail: MailDataToSend,
  files?: UploadedFileDynamicArray
) => {
  const rawMessage = getMimeMail(username, mail, files);
  const data = Buffer.from(rawMessage) as unknown as Uint8Array;
  const command = new SendRawEmailCommand({ RawMessage: { Data: data } });

  return await ses.send(command);
};
