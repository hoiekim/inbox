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
  getAccountUidNext,
  getUser
} from "server";
import { sendMailgunMail } from "./mailgun";
import { validateMailData, MailValidationError } from "./validation";
import { notifyNewMails } from "../push";

export class MailSendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendingError";
  }
}

export type UploadedFileDynamicArray = UploadedFile | UploadedFile[];

/**
 * Split recipients into local (on host domain) and external addresses.
 */
const splitRecipients = (
  to: string,
  cc?: string,
  bcc?: string
): { local: string[]; external: string[] } => {
  const domain = getDomain();
  const local: string[] = [];
  const external: string[] = [];

  const categorize = (addresses: string | undefined) => {
    if (!addresses) return;
    const domainLower = domain.toLowerCase();
    addressParser(addresses).forEach(({ email }) => {
      const emailDomain = email.split("@")[1]?.toLowerCase();
      // Match exact domain or subdomains (e.g., user@hoie.kim or user@sub.hoie.kim)
      const isLocal = emailDomain === domainLower || emailDomain?.endsWith(`.${domainLower}`);
      if (isLocal) {
        local.push(email);
      } else {
        external.push(email);
      }
    });
  };

  categorize(to);
  categorize(cc);
  categorize(bcc);

  return { local, external };
};

/**
 * Deliver mail locally to recipients on the host domain.
 * Returns list of usernames that received the mail.
 */
const deliverLocally = async (
  sender: SignedUser,
  mailToSend: MailDataToSend,
  localRecipients: string[],
  files?: UploadedFileDynamicArray
): Promise<string[]> => {
  const domain = getDomain();
  const deliveredTo: string[] = [];

  for (const recipientEmail of localRecipients) {
    // Extract username from email (e.g., "user@hoie.kim" -> "user")
    const emailParts = recipientEmail.split("@");
    const localPart = emailParts[0];
    const emailDomain = emailParts[1]?.toLowerCase();

    // Handle subdomain format (user.hoie.kim) vs direct domain (hoie.kim)
    let username: string;
    if (emailDomain === domain.toLowerCase()) {
      username = localPart;
    } else {
      // Subdomain format: extract subdomain as username
      const subDomain = emailDomain.split(`.${domain.toLowerCase()}`)[0];
      username = subDomain === domain.toLowerCase() ? "admin" : subDomain;
    }

    const recipient = await getUser({ username });
    const recipientId = recipient?.id;
    if (!recipientId) {
      console.warn(`Local recipient not found: ${recipientEmail} (username: ${username})`);
      continue;
    }

    // Create mail for recipient's inbox
    const messageId = randomUUID();
    const incomingMail = await getIncomingMail(sender, mailToSend, messageId, { id: recipientId }, recipientEmail, files);
    await saveMail(incomingMail, recipientId);
    deliveredTo.push(username);
    console.info(`Delivered locally to ${recipientEmail}`);
  }

  return deliveredTo;
};

/**
 * Create a Mail object for local delivery (as incoming mail to recipient).
 */
const getIncomingMail = async (
  sender: SignedUser,
  mailToSend: MailDataToSend,
  messageId: string,
  recipient: { id: string },
  recipientEmail: string,
  files?: UploadedFileDynamicArray
): Promise<Mail> => {
  const { username } = sender;
  const { senderFullName, to, cc, bcc, subject, html } = mailToSend;
  const senderAlias = mailToSend.sender;

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const fromEmail = `${senderAlias}@${userDomain}`;
  const attachments = (await getAttachmentsToSave(files)) || [];

  const [domainUid, accountUid] = await Promise.all([
    getDomainUidNext(recipient.id, true),
    getAccountUidNext(recipient.id, recipientEmail, true)
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
    envelopeTo: [{ address: recipientEmail }],
    replyTo: {
      value: [{ name: senderFullName, address: fromEmail }],
      text: fromEmail
    },
    read: false, // Incoming mail is unread
    sent: false, // Not in sent folder for recipient
    saved: false,
    uid
  });
};

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
  const { local: localRecipients, external: externalRecipients } = splitRecipients(
    mailToSend.to,
    mailToSend.cc,
    mailToSend.bcc
  );

  let response: { id?: string } = {};
  const deliveredUsernames: string[] = [];

  try {
    // Deliver locally first
    if (localRecipients.length > 0) {
      const delivered = await deliverLocally(user, mailToSend, localRecipients, files);
      deliveredUsernames.push(...delivered);
      console.info(`Local delivery completed: ${delivered.length} recipients`);
    }

    // Send to external recipients via Mailgun
    if (externalRecipients.length > 0) {
      // Filter mailToSend to only include external recipients
      const externalTo = externalRecipients.filter(e => addressParser(mailToSend.to).some(a => a.email === e)).join(",");
      const externalCc = mailToSend.cc ? externalRecipients.filter(e => addressParser(mailToSend.cc!).some(a => a.email === e)).join(",") || undefined : undefined;
      const externalBcc = mailToSend.bcc ? externalRecipients.filter(e => addressParser(mailToSend.bcc!).some(a => a.email === e)).join(",") || undefined : undefined;

      const externalMailData = new MailDataToSend({
        ...mailToSend,
        to: externalTo || mailToSend.to,
        cc: externalCc,
        bcc: externalBcc
      });

      // Only send if there are actual external recipients
      if (externalMailData.to || externalMailData.cc || externalMailData.bcc) {
        response = await sendMailgunMail(username, externalMailData, files);
        console.info("External email sending succeeded via Mailgun");
      }
    }

    // Save sender's copy to Sent folder (unless sending only to self)
    const sendingOnlyToSelf = localRecipients.length > 0 &&
      externalRecipients.length === 0 &&
      localRecipients.every(e => e.split("@")[0].toLowerCase() === username.toLowerCase());

    if (!sendingOnlyToSelf) {
      const messageId = response.id || randomUUID();
      const sentMail = await getSentMail(user, mailToSend, messageId, files);
      await saveMail(sentMail, userId);
    }

    // Notify local recipients of new mail
    if (deliveredUsernames.length > 0) {
      await notifyNewMails(deliveredUsernames);
      console.info(`Push notifications sent to: ${deliveredUsernames.join(", ")}`);
    }

    return response;
  } catch (error: any) {
    console.error("Email sending failed:", error);

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
