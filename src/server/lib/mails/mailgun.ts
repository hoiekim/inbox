import FormData from "form-data";
import Mailgun from "mailgun.js";
import { MailDataToSend } from "common";
import { getText, getUserDomain } from "server";
import { UploadedFileDynamicArray } from "./send";
import { UploadedFile } from "express-fileupload";

const { EMAIL_DOMAIN = "mydomain", MAILGUN_KEY = "mailgun_key" } = process.env;

// File attachment type matching mailgun.js expectations
interface MailgunAttachment {
  data: Buffer | string;
  filename?: string;
  contentType?: string;
  knownLength?: number;
}

const getAttachments = (files?: UploadedFileDynamicArray): MailgunAttachment[] => {
  const parseFile = (file: UploadedFile): MailgunAttachment => ({
    data: file.data,
    filename: file.name,
    contentType: file.mimetype,
    knownLength: file.size
  });

  if (Array.isArray(files)) return files.map(parseFile);
  else if (files) return [parseFile(files)];
  else return [];
};

export const sendMailgunMail = async (
  username: string,
  mail: MailDataToSend,
  files?: UploadedFileDynamicArray
) => {
  const { sender, senderFullName, to, cc, bcc, subject, html, inReplyTo } =
    mail;

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const from = `${senderFullName} <${sender}@${userDomain}>`;

  const mailgun = new Mailgun(FormData);
  const mg = mailgun.client({
    username: "api",
    key: MAILGUN_KEY
  });

  const mailgunMessage = {
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachment: getAttachments(files),
    "h:In-Reply-To": inReplyTo
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await mg.messages.create(EMAIL_DOMAIN, mailgunMessage as any);

  return data;
};
