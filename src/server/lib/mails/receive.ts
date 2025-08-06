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
  MaskedUser
} from "common";

import {
  elasticsearchClient,
  index,
  getUser,
  getText,
  getDomain,
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachmentId,
  notifyNewMails,
  getInsight,
  getDomainUidNext,
  getAccountUidNext
} from "server";

export const saveMailHandler = async (_: any, data: IncomingMail) => {
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
  await Promise.all(usernames.map((u) => saveIncomingMail(u, validData)));
  console.info("Successfully saved an email");

  await notifyNewMails(usernames);
  console.info(`Sent push notifications to users: [${usernames.toString()}]`);
};

const saveIncomingMail = async (username: string, incoming: IncomingMail) => {
  const user = await getUser({ username });
  if (!user) {
    console.warn(`User not found for username: ${username}`);
    console.warn("Skipping saving mail:", incoming);
    return;
  }

  const mail = await convertMail(user, incoming);

  return saveMail(user?.id, mail);
};

export const saveMail = async (userId: string | undefined, mail: Mail) => {
  return elasticsearchClient
    .index({
      index,
      document: {
        type: "mail",
        user: { id: userId },
        mail,
        updated: new Date().toISOString()
      }
    })
    .catch((r) => {
      console.error(r);
      const errorFilePath = `./error/${Date.now()}`;
      const errorContent = JSON.stringify({ ...mail, error: r });
      if (!fs.existsSync("./error")) fs.mkdirSync("./error");
      fs.writeFileSync(errorFilePath, errorContent);
    });
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
    messageId = getRandomId()
  } = incoming;

  const text = getText(html);
  const insight = await getInsight({ subject, from, to, text });
  const envelopeToAddress = envelopeTo[0]?.address || "";
  const [domainUid, accountUid] = await Promise.all([
    getDomainUidNext(user),
    getAccountUidNext(user, envelopeToAddress)
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
    uid
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
  size
}: IncomingAttachment) => {
  const isDataExist = typeof content === "object" && "data" in content;
  const data = isDataExist ? content.data : content;
  const id = await saveBuffer(data);
  return new Attachment({
    filename,
    contentType,
    content: { data: id },
    size
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
