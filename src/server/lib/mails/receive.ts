import fs from "fs";

import {
  MailAddressType,
  MailAddressValueType,
  getRandomId,
  IncomingMail,
  IncomingMailAddress,
  IncomingMailAddressValue,
  IncomingAttachment,
  Mail,
  Attachment,
  MailUid,
  MaskedUser,
} from "common";

import {
  saveMail as pgSaveMail,
  SaveMailInput,
  getDomainUidNext as pgGetDomainUidNext,
  getAccountUidNext as pgGetAccountUidNext,
} from "../postgres/repositories/mails";
import { getUser, getText, getDomain } from "server";
import {
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachmentId,
} from "./util";
import { notifyNewMails } from "../push";
import { getInsight } from "../ai";
import { checkSpam, SpamCheckResult, EmailContext } from "../spam";

export interface SaveMailHandlerOptions {
  remoteAddress?: string;
}

export const saveMailHandler = async (
  _: unknown,
  data: IncomingMail,
  options: SaveMailHandlerOptions = {}
) => {
  console.info("Received an email at", new Date());
  console.group();
  const envelopeTo = JSON.stringify(convertAddressValue(data.envelopeTo));
  console.log("envelopeTo:", envelopeTo);
  const from = JSON.stringify(convertMailAddress(data.from)?.value);
  console.log("from:", from);
  console.groupEnd();

  const domain = getDomain();
  const validData = validateIncomingMail(data, domain);
  if (!validData) {
    console.warn("Recipient is not valid. Mails is not saved.");
    return;
  }

  const usernames = getUsernamesFromIncomingMail(validData);
  await Promise.all(
    usernames.map((u) => saveIncomingMail(u, validData, { remoteAddress: options.remoteAddress }))
  );
  console.info("Successfully saved an email");

  await notifyNewMails(usernames);
  console.info(`Sent push notifications to users: [${usernames.toString()}]`);
};

interface SaveIncomingMailOptions {
  remoteAddress?: string;
}

const saveIncomingMail = async (
  username: string,
  incoming: IncomingMail,
  options: SaveIncomingMailOptions = {}
) => {
  const user = await getUser({ username });
  if (!user) {
    console.warn(`User not found for username: ${username}`);
    console.warn("Skipping saving mail:", incoming);
    return;
  }

  const mail = await convertMail(user, incoming);

  // Run spam check
  let spamResult: SpamCheckResult | undefined;
  if (user.id) {
    try {
      // Extract from address handling both single and array formats
      let fromAddress: string | undefined;
      let fromName: string | undefined;
      if (incoming.from) {
        if (Array.isArray(incoming.from)) {
          const firstFrom = incoming.from[0];
          if (firstFrom?.value) {
            const valueArray = Array.isArray(firstFrom.value) ? firstFrom.value : [firstFrom.value];
            fromAddress = valueArray[0]?.address;
          }
          fromName = incoming.from[0]?.text;
        } else {
          const fromValue = incoming.from.value;
          const valueArray = Array.isArray(fromValue) ? fromValue : [fromValue];
          fromAddress = valueArray[0]?.address;
          fromName = incoming.from.text;
        }
      }
      
      // Extract reply-to address handling both single and array formats
      let replyToAddress: string | undefined;
      if (incoming.replyTo) {
        if (Array.isArray(incoming.replyTo)) {
          const firstReplyTo = incoming.replyTo[0];
          if (firstReplyTo?.value) {
            const valueArray = Array.isArray(firstReplyTo.value) ? firstReplyTo.value : [firstReplyTo.value];
            replyToAddress = valueArray[0]?.address;
          }
        } else {
          const replyToValue = incoming.replyTo.value;
          const valueArray = Array.isArray(replyToValue) ? replyToValue : [replyToValue];
          replyToAddress = valueArray[0]?.address;
        }
      }
      
      const emailContext: EmailContext = {
        fromAddress,
        fromName,
        replyToAddress,
        subject: incoming.subject,
        text: incoming.text,
        html: incoming.html,
        remoteAddress: options.remoteAddress,
      };
      
      spamResult = await checkSpam(user.id, emailContext);
      
      if (spamResult.isSpam) {
        console.info(`[SpamFilter] Email marked as spam for user ${username}: score=${spamResult.score}, reasons=[${spamResult.reasons.join(", ")}]`);
      }
    } catch (error) {
      console.warn("[SpamFilter] Spam check failed, proceeding without spam filtering:", error);
    }
  }

  return saveMail(mail, user?.id, spamResult);
};

export const saveMail = async (
  mail: Mail,
  userId?: string,
  spamResult?: SpamCheckResult
): Promise<{ _id: string } | undefined> => {
  if (!userId) return;

  const input: SaveMailInput = {
    user_id: userId,
    message_id: mail.messageId,
    subject: mail.subject,
    date: mail.date,
    html: mail.html,
    text: mail.text,
    from_address: mail.from?.value,
    from_text: mail.from?.text,
    to_address: mail.to?.value,
    to_text: mail.to?.text,
    cc_address: mail.cc?.value,
    cc_text: mail.cc?.text,
    bcc_address: mail.bcc?.value,
    bcc_text: mail.bcc?.text,
    reply_to_address: mail.replyTo?.value,
    reply_to_text: mail.replyTo?.text,
    envelope_from: mail.envelopeFrom,
    envelope_to: mail.envelopeTo,
    attachments: mail.attachments,
    read: mail.read,
    saved: mail.saved,
    sent: mail.sent,
    deleted: mail.deleted,
    draft: mail.draft,
    insight: mail.insight,
    uid_domain: mail.uid?.domain,
    uid_account: mail.uid?.account,
    spam_score: spamResult?.score ?? 0,
    spam_reasons: spamResult?.reasons ?? null,
    is_spam: spamResult?.isSpam ?? false,
  };

  try {
    return await pgSaveMail(input);
  } catch (error) {
    console.error("Error saving mail:", error);
    const errorFilePath = `./error/${Date.now()}`;
    const errorContent = JSON.stringify({ ...mail, error });
    if (!fs.existsSync("./error")) fs.mkdirSync("./error");
    fs.writeFileSync(errorFilePath, errorContent);
    return undefined;
  }
};

export const convertMail = async (
  user: MaskedUser,
  incoming: IncomingMail
): Promise<Mail> => {
  const from = convertMailAddress(incoming.from);
  const to = convertMailAddress(incoming.to);
  const cc = convertMailAddress(incoming.cc);
  const bcc = convertMailAddress(incoming.bcc);
  const replyTo = convertMailAddress(incoming.replyTo);

  const envelopeFrom = convertAddressValue(incoming.envelopeFrom);
  const envelopeTo = convertAddressValue(
    incoming.envelopeTo
  ) as MailAddressValueType[];

  const attachments = await convertAttachments(incoming.attachments);

  const {
    subject = "",
    date = new Date().toISOString(),
    html = "",
    text: incomingText,
    messageId = getRandomId(),
  } = incoming;

  const text = incomingText ?? getText(html);
  const insight = await getInsight({ subject, from, to, text });
  const envelopeToAddress = envelopeTo[0]?.address || "";

  if (!user.id) {
    throw new Error("User ID is required to save mail");
  }

  const [domainUid, accountUid] = await Promise.all([
    pgGetDomainUidNext(user.id!),
    pgGetAccountUidNext(user.id!, envelopeToAddress),
  ]);

  const uid = new MailUid({ domain: domainUid || 0, account: accountUid || 0 });

  return new Mail({
    messageId,
    attachments,
    to,
    from,
    cc,
    bcc,
    replyTo,
    envelopeTo,
    envelopeFrom,
    text,
    insight,
    date,
    html,
    subject,
    read: false,
    saved: false,
    sent: false,
    uid,
  });
};

const convertMailAddress = (
  incoming?: IncomingMailAddress | IncomingMailAddress[]
): MailAddressType | undefined => {
  if (!incoming) return undefined;
  if (Array.isArray(incoming)) {
    if (!incoming.length) return undefined;
    const value = convertAddressValue(incoming.flatMap(({ value }) => value));
    if (!value) return undefined;
    const text = incoming.map(({ text }) => text).join(", ");
    return { value, text };
  }
  const value = convertAddressValue(incoming.value);
  if (!value) return undefined;
  const { text } = incoming;
  return { value, text };
};

const convertAddressValue = (
  incoming?: IncomingMailAddressValue | IncomingMailAddressValue[]
) => {
  if (!incoming) return undefined;
  const array: MailAddressValueType[] = [];
  const push = ({ address, name }: IncomingMailAddressValue) => {
    const value = { address: address?.toLowerCase(), name };
    array.push(value);
  };
  if (Array.isArray(incoming)) {
    if (incoming.length) incoming.forEach(push);
    else return undefined;
  } else if (incoming) push(incoming);
  return array;
};

const convertAttachments = async (
  incoming?: IncomingAttachment | IncomingAttachment[]
): Promise<Attachment[] | undefined> => {
  if (!incoming) return undefined;
  const array: IncomingAttachment[] = [];
  if (Array.isArray(incoming)) array.push(...incoming);
  else array.push(incoming);
  const attachments = array.map(convertAttachment);
  return Promise.all(attachments);
};

const convertAttachment = async ({
  content,
  filename,
  contentType,
  size,
}: IncomingAttachment) => {
  const isDataExist = typeof content === "object" && "data" in content;
  const data = isDataExist ? content.data : content;
  const id = await saveBuffer(data);
  return new Attachment({
    filename,
    contentType,
    content: { data: id },
    size,
  });
};

export const saveBuffer = (buffer: Buffer | string): Promise<string> => {
  const id = getAttachmentId();
  if (!fs.existsSync(ATTACHMENT_FOLDER)) fs.mkdirSync(ATTACHMENT_FOLDER);
  const attachmentFilePath = getAttachmentFilePath(id);
  return new Promise((res, rej) => {
    try {
      if (typeof buffer === "string") {
        buffer = Buffer.from(buffer, "base64");
      }
      fs.writeFileSync(attachmentFilePath, buffer as unknown as Uint8Array);
      res(id);
    } catch (reason) {
      rej(reason);
    }
  });
};

const getUsernamesFromIncomingMail = (data: IncomingMail): string[] => {
  const { envelopeTo } = data;
  if (!envelopeTo) return [];
  const array: MailAddressValueType[] = [];
  if (Array.isArray(envelopeTo)) array.push(...envelopeTo);
  else array.push(envelopeTo);
  const domain = getDomain();
  return array
    .filter((e) => e.address && isValidAddress(e.address, domain))
    .map((e) => addressToUsername(e.address as string));
};

const isValidAddress = (address: string, domain: string) => {
  const parsedAddress = address.split("@");
  const domainInData = parsedAddress[parsedAddress.length - 1];
  return domainInData.toLowerCase().includes(domain.toLowerCase());
};

export const validateIncomingMail = (
  data?: IncomingMail,
  domainName?: string
): IncomingMail | undefined => {
  if (!data || !domainName) return undefined;

  const { envelopeTo } = data;
  if (!envelopeTo) return undefined;

  const addressArray: MailAddressValueType[] = [];
  if (Array.isArray(envelopeTo)) addressArray.push(...envelopeTo);
  else addressArray.push(envelopeTo);

  const isAddressCorrect = !!addressArray.find((e) => {
    return e.address && isValidAddress(e.address, domainName);
  });

  if (isAddressCorrect) return data as IncomingMail;
  return undefined;
};

export const addressToUsername = (address: string) => {
  const domain = getDomain();
  const parsedAddress = address.split("@");
  const domainInAddress = parsedAddress[parsedAddress.length - 1];
  const subDomain = domainInAddress.split(`.${domain}`)[0]?.toLowerCase();
  return subDomain === domain ? "admin" : subDomain;
};
