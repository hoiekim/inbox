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

export type UploadedFileDynamicArray = UploadedFile | UploadedFile[];

export const sendMail = async (
  user: SignedUser,
  mailToSend: MailDataToSend,
  files?: UploadedFileDynamicArray
) => {
  const { id: userId, username } = user;
  try {
    const response = await sendMailgunMail(username, mailToSend, files);

    console.info("Email sending request succeeded");

    if (!isToMyself(mailToSend.to)) {
      const messageId = response.id || randomUUID();
      const sentMail = await getSentMail(user, mailToSend, messageId, files);
      await saveMail(userId, sentMail);
    }

    return response;
  } catch (error: any) {
    console.error("Email sending request failed");
    throw error;
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
    getDomainUidNext(user, true),
    getAccountUidNext(user, fromEmail, true)
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
