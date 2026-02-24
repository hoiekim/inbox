import FormData from "form-data";
import Mailgun from "mailgun.js";
import type { MailgunMessageData, CustomFile } from "mailgun.js/definitions";
import { MailDataToSend } from "common";
import { getText, getUserDomain } from "server";
import { UploadedFileDynamicArray } from "./send";
import { UploadedFile } from "express-fileupload";

const { EMAIL_DOMAIN = "mydomain", MAILGUN_KEY = "mailgun_key" } = process.env;

const getAttachments = (files?: UploadedFileDynamicArray): CustomFile[] => {
  const parseFile = (file: UploadedFile): CustomFile => ({
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

  const tos = to.split(",").map((addr) => addr.trim());
  const envelopTo = tos.filter((addr) => !addr.endsWith(`@${EMAIL_DOMAIN}`));

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const from = `${senderFullName} <${sender}@${userDomain}>`;

  const mailgun = new Mailgun(FormData);
  const mg = mailgun.client({
    username: "api",
    key: MAILGUN_KEY
  });

  const mailgunMessage: MailgunMessageData = {
    from,
    to: envelopTo,
    cc,
    bcc,
    subject,
    html,
    text,
    attachment: getAttachments(files),
    "h:To": to,
    "h:In-Reply-To": inReplyTo
  };

  const data = await mg.messages.create(EMAIL_DOMAIN, mailgunMessage);

  return data;
};
