import { randomUUID } from "crypto";
import fs from "fs";
import { UploadedFile } from "express-fileupload";
import {
  AttachmentType,
  Mail,
  MailDataToSend,
  MailUid,
  SignedUser
} from "common";
import {
  getUserDomain,
  saveMail,
  getText,
  saveBuffer,
  getDomainUidNext,
  getAccountUidNext
} from "server";
import { sendMailgunMail } from "./mailgun";
import { validateMailData, MailValidationError } from "./validation";
import { sendAlarm } from "../alarm";

export class MailSendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendingError";
  }
}

export type UploadedFileDynamicArray = UploadedFile | UploadedFile[];

export const sendMail = async (
  user: SignedUser,
  mailToSend: MailDataToSend,
  files?: UploadedFileDynamicArray
) => {
  // Validate mail data before sending
  const validation = validateMailData(mailToSend);
  if (!validation.valid) {
    throw new MailValidationError(validation.error!);
  }

  const { id: userId, username } = user;
  try {
    const response = await sendMailgunMail(username, mailToSend, files);
    const messageId = response?.id || randomUUID();
    const sentMail = await getSentMail(user, mailToSend, messageId, files);
    await saveMail(sentMail, userId);

    return response;
  } catch (error: unknown) {
    console.error("Email sending request failed", error);
    sendAlarm(
      "Mail Send Failed",
      `**Error:** ${error instanceof Error ? error.message : String(error)}`
    ).catch(() => undefined);

    // Provide user-friendly error messages for common Mailgun errors
    let message = "Failed to send email. Please try again.";

    const err = error as { status?: number; message?: string; code?: string };
    if (err?.status === 401 || err?.status === 403) {
      message = "Email service not configured correctly";
    } else if (err?.status === 400) {
      message = err?.message || "Invalid email request";
    } else if (err?.status === 429) {
      message = "Too many requests. Please try again later.";
    } else if (err?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED") {
      message = "Unable to reach email service. Please try again later.";
    } else if (err?.code === "ECONNRESET" || (error as { details?: string })?.details === "socket hang up") {
      message = err?.message || "Failed to send email. Please try again.";
    }

    throw new MailSendingError(message);
  }
};

const getSentMail = async (
  user: SignedUser,
  mailToSend: MailDataToSend,
  messageId: string,
  files?: UploadedFileDynamicArray
): Promise<Mail> => {
  const { username } = user;
  const { sender, senderFullName, to, cc, bcc, subject, html } = mailToSend;

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const fromEmail = `${sender}@${userDomain}`;
  const attachments = (await getAttachmentsToSave(files)) || [];

  const [domainUid, accountUid] = await Promise.all([
    getDomainUidNext(user.id, true),
    getAccountUidNext(user.id, fromEmail, true)
  ]);

  const uid = new MailUid({ domain: domainUid || 0, account: accountUid || 0 });

  return new Mail({
    subject,
    text,
    html,
    date: new Date().toISOString(),
    attachments,
    messageId: `<${messageId}@${userDomain}>`,
    from: {
      value: [{ name: senderFullName || undefined, address: fromEmail }],
      text: senderFullName ? `${senderFullName} <${fromEmail}>` : fromEmail
    },
    to: { value: [{ address: to }], text: to },
    cc: !cc ? undefined : { value: [{ address: cc }], text: cc },
    bcc: !bcc ? undefined : { value: [{ address: bcc }], text: bcc },
    envelopeFrom: [{ name: senderFullName || undefined, address: fromEmail }],
    envelopeTo: [{ address: to }],
    replyTo: {
      value: [{ name: senderFullName || undefined, address: fromEmail }],
      text: fromEmail
    },
    read: true,
    sent: true,
    saved: false,
    uid
  });
};

const getAttachmentsToSave = async (files?: UploadedFileDynamicArray) => {
  const noFiles = Array.isArray(files) ? !files.length : !files;
  if (noFiles) return undefined;

  const attachmentsToSave: AttachmentType[] = [];

  const parseFile = async (file: UploadedFile) => {
    // With useTempFiles:true, file.data is an empty Buffer — read from tempFilePath.
    const buffer = file.tempFilePath
      ? fs.readFileSync(file.tempFilePath)
      : file.data;
    attachmentsToSave.push({
      content: { data: await saveBuffer(buffer) },
      filename: file.name,
      contentType: file.mimetype,
      size: file.size
    });
  };

  if (Array.isArray(files)) await Promise.all(files.map(parseFile));
  else if (files) await parseFile(files as UploadedFile);

  return attachmentsToSave;
};

export const addressParser = (str: string) => {
  const result = str
    .split(",")
    .map((e) => e.replace(/ /g, ""))
    .filter((str) => typeof str === "string" && str.split("@").length === 2)
    .map((e) => ({ email: e }));
  return result;
};
