import FormData from "form-data";
import fs from "fs";
import Mailgun from "mailgun.js";
import type { MailgunMessageData, CustomFile } from "mailgun.js/definitions";
import { MailDataToSend } from "common";
import { getText, getUserDomain } from "server";
import { UploadedFileDynamicArray } from "./send";
import { UploadedFile } from "express-fileupload";
import { logger } from "../logger";

const { MAILGUN_KEY = "mailgun_key" } = process.env;

/**
 * Returns the file data as a Buffer.
 * With useTempFiles:true, file.data is an empty Buffer — read from tempFilePath instead.
 */
const getFileData = (file: UploadedFile): Buffer => {
  if (file.tempFilePath) return fs.readFileSync(file.tempFilePath);
  return file.data;
};

const getAttachments = (files?: UploadedFileDynamicArray): CustomFile[] => {
  const parseFile = (file: UploadedFile): CustomFile => ({
    data: getFileData(file),
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

  // Read at call time: the filter below is only meaningful against the domain
  // the process is actually serving.
  const { EMAIL_DOMAIN = "mydomain" } = process.env;

  const addresses = (list?: string) =>
    (list ?? "")
      .split(",")
      .map((addr) => addr.trim())
      .filter(Boolean);
  const isExternal = (address: string) => !address.endsWith(`@${EMAIL_DOMAIN}`);

  const recipients = [...addresses(to), ...addresses(cc), ...addresses(bcc)];
  if (recipients.length && !recipients.some(isExternal)) {
    logger.info("All recipients are to myself, skipping Mailgun sending.");
    return;
  }

  const externalTo = addresses(to).filter(isExternal);
  const externalCc = addresses(cc).filter(isExternal);
  const externalBcc = addresses(bcc).filter(isExternal);

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const fromAddress = `${sender}@${userDomain}`;
  const from = senderFullName
    ? `${senderFullName} <${fromAddress}>`
    : fromAddress;

  // Mailgun renders the visible `To:` header from the `to` parameter and
  // rejects a message that carries none, so the address put there has to be
  // both deliverable off this host and already disclosed to everyone on the
  // message. An external addressee qualifies, and so does an external Cc — the
  // `Cc:` header names it anyway. A Bcc address is disclosed to nobody but
  // itself, so a send whose only external recipients are Bcc goes out as one
  // message per recipient. Naming the sender instead hands Mailgun a
  // host-domain recipient, which routes the copy back at our own MX.
  const visibleTo = externalTo.length ? externalTo : externalCc;

  const mailgun = new Mailgun(FormData);
  const mg = mailgun.client({
    username: "api",
    key: MAILGUN_KEY,
    timeout: 30000
  });

  // Built once: the per-recipient send below would otherwise hold a fresh copy
  // of every attachment for every recipient, all alive in the same tick.
  const attachment = getAttachments(files);
  const message = (
    to: string[],
    hidden?: { cc?: string; bcc?: string }
  ): MailgunMessageData => ({
    from,
    to,
    cc: hidden?.cc,
    bcc: hidden?.bcc,
    subject,
    html,
    text,
    attachment,
    "h:In-Reply-To": inReplyTo
  });

  // A per-recipient send carries no Cc: every Cc address is host-domain here,
  // or one of them would have been the visible To.
  const data = visibleTo.length
    ? await mg.messages.create(EMAIL_DOMAIN, message(visibleTo, { cc, bcc }))
    : (
        await Promise.all(
          externalBcc.map((address) =>
            mg.messages.create(EMAIL_DOMAIN, message([address]))
          )
        )
      )[0];

  logger.info("Email sending request succeeded");

  return data;
};
