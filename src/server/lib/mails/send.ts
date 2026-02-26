import { randomUUID } from "crypto";
import { UploadedFile } from "express-fileupload";
import {
  AttachmentType,
  Mail,
  MailDataToSend,
  MailUid,
  SignedUser
} from "common";
import {
  getDomain,
  getUserDomain,
  saveMail,
  getText,
  saveBuffer,
  getDomainUidNext,
  getAccountUidNext
} from "server";
import { sendMailgunMail } from "./mailgun";
import { validateMailData, MailValidationError } from "./validation";

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
    if (isToMyself(mailToSend.to)) {
      // If the email is sent to myself, also save a copy in the inbox
      await saveMail(new Mail({ ...sentMail, sent: false }), userId);
    }

    return response;
  } catch (error: any) {
    console.error("Email sending request failed", error);

    // Provide user-friendly error messages for common Mailgun errors
    let message = "Failed to send email. Please try again.";

    if (error?.status === 401 || error?.status === 403) {
      message = "Email service not configured correctly";
    } else if (error?.status === 400) {
      message = error?.message || "Invalid email request";
    } else if (error?.status === 429) {
      message = "Too many requests. Please try again later.";
    } else if (error?.code === "ENOTFOUND" || error?.code === "ECONNREFUSED") {
      message = "Unable to reach email service. Please try again later.";
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
      value: [{ name: senderFullName, address: fromEmail }],
      text: `${senderFullName} <${fromEmail}>`
    },
    to: { value: [{ address: to }], text: to },
    cc: !cc ? undefined : { value: [{ address: cc }], text: cc },
    bcc: !bcc ? undefined : { value: [{ address: bcc }], text: bcc },
    envelopeFrom: [{ name: senderFullName, address: fromEmail }],
    envelopeTo: [{ address: to }],
    replyTo: {
      value: [{ name: senderFullName, address: fromEmail }],
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

  const parseFile = async ({ name, data, mimetype, size }: UploadedFile) => {
    attachmentsToSave.push({
      content: { data: await saveBuffer(data) },
      filename: name,
      contentType: mimetype,
      size
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

const isToMyself = (to: string) => {
  const toDomains = addressParser(to)?.map(({ email }) => {
    const splitString = email.split("@")[1].split(".");
    const length = splitString.length;
    return splitString[length - 2] + "." + splitString[length - 1];
  });

  const domain = getDomain();

  return !!toDomains?.find((e: string) => e === domain);
};
