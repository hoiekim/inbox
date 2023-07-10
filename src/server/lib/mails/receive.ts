import fs from "fs";
import {
  elasticsearchClient,
  index,
  getUser,
  getInsight,
  IncomingMail,
  IncomingMailAddressValue,
  IncomingAttachment,
  Mail,
  MailAddress,
  MailAddressValue,
  getText,
  getDomain,
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getAttachmentId,
  notifyNewMails
} from "server";

export const saveMailHandler = async (_: any, data: IncomingMail) => {
  console.info("Received an email at", new Date());
  console.group();
  console.log("envelopeFrom:", JSON.stringify(data.envelopeFrom));
  console.log("envelopeTo:", JSON.stringify(data.envelopeTo));
  console.log("from:", data.from?.text);
  console.log("to:", data.to?.text);
  console.groupEnd();

  const domain = getDomain();
  if (!validateMailAddress(data, domain)) {
    console.warn(
      "Skipped saving incoming mail because recipient is not valid."
    );
    return;
  }

  const usernames = getUsernamesFromIncomingMail(data);
  await Promise.all(usernames.map((u) => saveIncomingMail(u, data)));
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

const convertMail = async (incoming: IncomingMail): Promise<Mail> => {
  const from: MailAddress = {
    value: convertAddressValue(incoming.from.value),
    text: incoming.from.text.toLowerCase()
  };

  const to: MailAddress = {
    value: convertAddressValue(incoming.to.value),
    text: incoming.to.text.toLowerCase()
  };

  const envelopeFrom = convertAddressValue(incoming.envelopeFrom);
  const envelopeTo = convertAddressValue(incoming.envelopeTo);
  const attachments = convertAttachments(incoming.attachments);

  const { subject, date, html } = incoming;

  const text = getText(html);
  const insight = await getInsight({ subject, from, to, text });

  return {
    attachments,
    to,
    from,
    envelopeTo,
    envelopeFrom,
    text,
    insight,
    date,
    html,
    subject,
    read: false
  };
};

const convertAddressValue = (incoming: IncomingMailAddressValue) => {
  const array: MailAddressValue[] = [];

  const push = (v: MailAddressValue) => {
    const value = { ...v };
    value.address = value.address.toLowerCase();
    array.push(value);
  };

  if (Array.isArray(incoming)) incoming.forEach(push);
  else if (incoming) push(incoming);

  return array;
};

const convertAttachments = (incoming: IncomingAttachment[]) => {
  return incoming.map(({ content, filename, contentType }) => {
    const data = typeof content === "string" ? content : content.data;
    const id = saveBuffer(data);
    return { filename, contentType, content: { data: id } };
  });
};

export const saveBuffer = (buffer: Buffer | string) => {
  const id = getAttachmentId();
  if (!fs.existsSync(ATTACHMENT_FOLDER)) fs.mkdirSync(ATTACHMENT_FOLDER);
  fs.writeFile(getAttachmentFilePath(id), Buffer.from(buffer), (err) => {
    if (err) throw err;
  });
  return id;
};

const getUsernamesFromIncomingMail = (data: IncomingMail): string[] => {
  if (!Array.isArray(data.envelopeTo)) data.envelopeTo = [data.envelopeTo];
  const domain = getDomain();
  return data.envelopeTo
    .filter((e) => e.address && isValidAddress(e.address, domain))
    .map((e) => addressToUsername(e.address));
};

const isValidAddress = (address: string, domain: string) => {
  const parsedAddress = address.split("@");
  const domainInData = parsedAddress[parsedAddress.length - 1];
  return domainInData.toLowerCase().includes(domain.toLowerCase());
};

export const validateMailAddress = (
  data: { envelopeTo: MailAddressValue | MailAddressValue[] },
  domainName: string
) => {
  if (!data || !domainName) return false;
  if (!Array.isArray(data.envelopeTo)) data.envelopeTo = [data.envelopeTo];
  const isAddressCorrect = !!data.envelopeTo.find((e) => {
    return e.address && isValidAddress(e.address, domainName);
  });
  return isAddressCorrect;
};

export const addressToUsername = (address: string) => {
  const domain = getDomain();
  const parsedAddress = address.split("@");
  const domainInAddress = parsedAddress[parsedAddress.length - 1];
  const subDomain = domainInAddress.split(`.${domain}`)[0];
  return subDomain === domain ? "admin" : subDomain;
};
