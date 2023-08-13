import fs from "fs";
import {
  elasticsearchClient,
  index,
  getUser,
  IncomingMail,
  IncomingMailAddressValue,
  IncomingAttachment,
  getText,
  getDomain,
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachmentId,
  notifyNewMails,
  IncomingMailAddress,
  getInsight
} from "server";
import {
  Attachment,
  Mail,
  MailAddress,
  MailAddressValue,
  getRandomId
} from "common";

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
  const [user, mail] = await Promise.all([
    getUser({ username }),
    convertMail(incoming)
  ]);

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
      const errorFilePath = `./error/${Date.now()}`;
      const errorContent = JSON.stringify({ ...mail, error: r });
      fs.writeFileSync(errorFilePath, errorContent);
    });
};

export const convertMail = async (incoming: IncomingMail): Promise<Mail> => {
  const from = convertMailAddress(incoming.from);
  const to = convertMailAddress(incoming.to);
  const cc = convertMailAddress(incoming.cc);
  const bcc = convertMailAddress(incoming.bcc);
  const replyTo = convertMailAddress(incoming.replyTo);

  const envelopeFrom = convertAddressValue(incoming.envelopeFrom);
  const envelopeTo = convertAddressValue(
    incoming.envelopeTo
  ) as MailAddressValue[];

  const attachments = await convertAttachments(incoming.attachments);

  const {
    subject = "",
    date = new Date().toISOString(),
    html = "",
    messageId = getRandomId()
  } = incoming;

  const text = getText(html);
  const insight = await getInsight({ subject, from, to, text });

  return {
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
    sent: false
  };
};

const convertMailAddress = (
  incoming?: IncomingMailAddress | IncomingMailAddress[]
): MailAddress | undefined => {
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
  const array: MailAddressValue[] = [];
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
  return Promise.all(
    array.map(async ({ content, filename, contentType }) => {
      const data =
        typeof content === "object" && "data" in content
          ? content.data
          : content;
      const id = await saveBuffer(data);
      return { filename, contentType, content: { data: id } };
    })
  );
};

export const saveBuffer = (buffer: Buffer | string): Promise<string> => {
  const id = getAttachmentId();
  if (!fs.existsSync(ATTACHMENT_FOLDER)) fs.mkdirSync(ATTACHMENT_FOLDER);
  const attachmentFilePath = getAttachmentFilePath(id);
  return new Promise((res, rej) => {
    try {
      fs.writeFileSync(attachmentFilePath, Buffer.from(buffer));
      res(id);
    } catch (reason) {
      rej(reason);
    }
  });
};

const getUsernamesFromIncomingMail = (data: IncomingMail): string[] => {
  const { envelopeTo } = data;
  if (!envelopeTo) return [];
  const array: MailAddressValue[] = [];
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

  const addressArray: MailAddressValue[] = [];
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
