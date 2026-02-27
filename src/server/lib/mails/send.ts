import { randomUUID } from "crypto";
import { UploadedFile } from "express-fileupload";
import {
  AttachmentType,
  Mail,
  MailDataToSend,
  MailUid,
  SignedUser,
  MaskedUser,
  IncomingMail
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
import { convertMail, addressToUsername } from "./receive";
import { notifyNewMails } from "../push";

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

  // Split recipients into local and external
  const { localRecipients, externalRecipients } = splitRecipients(
    mailToSend.to,
    mailToSend.cc,
    mailToSend.bcc
  );

  const messageId = randomUUID();
  let mailgunResponse: Awaited<ReturnType<typeof sendMailgunMail>>;

  try {
    // Send to external recipients via Mailgun (if any)
    if (externalRecipients.to || externalRecipients.cc || externalRecipients.bcc) {
      const externalMailData = new MailDataToSend({
        ...mailToSend,
        to: externalRecipients.to || "",
        cc: externalRecipients.cc,
        bcc: externalRecipients.bcc
      });
      mailgunResponse = await sendMailgunMail(username, externalMailData, files);
    }

    // Save sender's copy to Sent folder
    const sentMail = await getSentMail(
      user,
      mailToSend,
      mailgunResponse?.id || messageId,
      files
    );
    await saveMail(sentMail, userId);

    // Deliver to local recipients directly
    if (localRecipients.length > 0) {
      await deliverToLocalRecipients(user, mailToSend, sentMail, localRecipients);
    }

    return mailgunResponse;
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

interface SplitRecipientsResult {
  localRecipients: string[];
  externalRecipients: {
    to?: string;
    cc?: string;
    bcc?: string;
  };
}

/**
 * Split recipients into local (on host domain) and external addresses.
 * Returns unique local usernames and comma-separated external address strings.
 */
const splitRecipients = (
  to: string,
  cc?: string,
  bcc?: string
): SplitRecipientsResult => {
  const domain = getDomain();
  const localUsernames = new Set<string>();

  const splitField = (field?: string): { local: string[]; external: string[] } => {
    if (!field) return { local: [], external: [] };
    const parsed = addressParser(field);
    const local: string[] = [];
    const external: string[] = [];

    for (const { email } of parsed) {
      if (isLocalAddress(email, domain)) {
        local.push(email);
        localUsernames.add(addressToUsername(email));
      } else {
        external.push(email);
      }
    }

    return { local, external };
  };

  const toSplit = splitField(to);
  const ccSplit = splitField(cc);
  const bccSplit = splitField(bcc);

  return {
    localRecipients: Array.from(localUsernames),
    externalRecipients: {
      to: toSplit.external.length > 0 ? toSplit.external.join(",") : undefined,
      cc: ccSplit.external.length > 0 ? ccSplit.external.join(",") : undefined,
      bcc: bccSplit.external.length > 0 ? bccSplit.external.join(",") : undefined
    }
  };
};

/**
 * Check if an email address belongs to the host domain.
 */
const isLocalAddress = (email: string, domain: string): boolean => {
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const emailDomain = parts[1].toLowerCase();
  // Match exact domain or subdomains (e.g., user.domain.com for domain.com)
  return emailDomain === domain || emailDomain.endsWith(`.${domain}`);
};

/**
 * Deliver mail directly to local recipients' inboxes.
 */
const deliverToLocalRecipients = async (
  sender: SignedUser,
  mailToSend: MailDataToSend,
  sentMail: Mail,
  localUsernames: string[]
): Promise<void> => {
  const deliveryPromises = localUsernames.map(async (username) => {
    // Don't double-deliver to sender (they already have it in Sent)
    if (username === sender.username) return;

    const recipient = await getUser({ username });
    if (!recipient) {
      console.warn(`Local delivery failed: user "${username}" not found`);
      return;
    }

    // Convert sent mail to incoming format for the recipient
    const incomingMail = sentMailToIncoming(sentMail, mailToSend);
    const recipientMail = await convertMail(recipient as MaskedUser, incomingMail);

    await saveMail(recipientMail, recipient.id);
    console.info(`Delivered mail locally to user: ${username}`);
  });

  await Promise.all(deliveryPromises);

  // Send push notifications to local recipients
  const recipientsToNotify = localUsernames.filter((u) => u !== sender.username);
  if (recipientsToNotify.length > 0) {
    await notifyNewMails(recipientsToNotify);
  }
};

/**
 * Convert a sent Mail object to IncomingMail format for local delivery.
 */
const sentMailToIncoming = (sentMail: Mail, mailToSend: MailDataToSend): IncomingMail => {
  const { to, cc, bcc } = mailToSend;

  // Build envelope recipients from all fields
  const allRecipients = [
    ...addressParser(to).map(({ email }) => ({ address: email })),
    ...(cc ? addressParser(cc).map(({ email }) => ({ address: email })) : []),
    ...(bcc ? addressParser(bcc).map(({ email }) => ({ address: email })) : [])
  ];

  return {
    messageId: sentMail.messageId,
    subject: sentMail.subject,
    date: sentMail.date,
    html: sentMail.html,
    text: sentMail.text,
    from: sentMail.from,
    to: sentMail.to,
    cc: sentMail.cc,
    // Don't include bcc in the recipient's view
    replyTo: sentMail.replyTo,
    envelopeFrom: sentMail.envelopeFrom,
    envelopeTo: allRecipients,
    attachments: sentMail.attachments
  } as IncomingMail;
};
