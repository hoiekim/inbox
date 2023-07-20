import { UploadedFile } from "express-fileupload";
import sgMail, { MailDataRequired as SendgridMail } from "@sendgrid/mail";
import { AttachmentData as SendgridAttachment } from "@sendgrid/helpers/classes/attachment";

import {
  getDomain,
  getUserDomain,
  saveMail,
  getText,
  MailDataToSend,
  Mail,
  Attachment,
  saveBuffer,
  MaskedUser
} from "server";

sgMail.setApiKey(process.env.SENDGRID_KEY || "");

export type UploadedFileDynamicArray = UploadedFile | UploadedFile[];

export const sendMail = async (
  user: MaskedUser,
  mailToSend: MailDataToSend,
  files?: UploadedFileDynamicArray
) => {
  const { id: userId, username } = user;
  const sendgridMail = getSendgridMail(username, mailToSend, files);
  const response = await sgMail.send(sendgridMail);

  console.info("Sendgrid email sending request succeeded");

  if (!isToMyself(mailToSend.to)) {
    const messageId = response[0].headers["x-message-id"];
    const sentMail = await getSentMail(username, mailToSend, messageId, files);
    await saveMail(userId, sentMail);
  }

  return response;
};

const getSendgridMail = (
  username: string,
  mailToSend: MailDataToSend,
  files?: UploadedFileDynamicArray
): SendgridMail => {
  const { sender, senderFullName, to, cc, bcc, subject, html, inReplyTo } =
    mailToSend;

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const from = { name: senderFullName, email: `${sender}@${userDomain}` };

  return {
    from,
    subject,
    text,
    html,
    to: addressParser(to),
    cc: cc && addressParser(cc),
    bcc: bcc && addressParser(bcc),
    attachments: getAttachmentsToSend(files),
    headers: inReplyTo ? { inReplyTo } : undefined
  };
};

const getSentMail = async (
  username: string,
  mailToSend: MailDataToSend,
  messageId: string,
  files?: UploadedFileDynamicArray
): Promise<Mail> => {
  const { sender, senderFullName, to, cc, bcc, subject, html } = mailToSend;

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const fromEmail = `${sender}@${userDomain}`;
  const attachments = (await getAttachmentsToSave(files)) || [];

  return {
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
    saved: false
  };
};

const getAttachmentsToSend = (files?: UploadedFileDynamicArray) => {
  const noFiles = Array.isArray(files) ? !files.length : !files;
  if (noFiles) return undefined;

  const attachmentsToSend: SendgridAttachment[] = [];

  const parseFile = ({ name, data, mimetype }: UploadedFile) => {
    attachmentsToSend.push({
      filename: name,
      content: data.toString("base64"),
      type: mimetype,
      disposition: "attachment"
    });
  };

  if (Array.isArray(files)) files.forEach(parseFile);
  else if (files) parseFile(files as UploadedFile);

  return attachmentsToSend;
};

const getAttachmentsToSave = async (files?: UploadedFileDynamicArray) => {
  const noFiles = Array.isArray(files) ? !files.length : !files;
  if (noFiles) return undefined;

  const attachmentsToSave: Attachment[] = [];

  const parseFile = async ({ name, data, mimetype }: UploadedFile) => {
    attachmentsToSave.push({
      content: { data: await saveBuffer(data) },
      filename: name,
      contentType: mimetype
    });
  };

  if (Array.isArray(files)) await Promise.all(files.map(parseFile));
  else if (files) await parseFile(files as UploadedFile);

  return attachmentsToSave;
};

const addressParser = (str: string) => {
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
