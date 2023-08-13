import { Mail, MailAddress, MailAddressValue, getRandomId } from "common";
import {
  IncomingMail,
  IncomingMailAddressValue,
  getText,
  IncomingMailAddress
} from "server";

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

  const attachments = incoming.attachments as any;

  const {
    subject = "",
    date = new Date().toISOString(),
    html = "",
    messageId = getRandomId()
  } = incoming;

  const text = getText(html);
  const insight = (incoming as any).insight;
  const sent = !!from && isSentMail(from.value);

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
    read: true,
    saved: false,
    sent
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

const isSentMail = (
  incoming: IncomingMailAddressValue | IncomingMailAddressValue[]
) => {
  const array = Array.isArray(incoming) ? incoming : [incoming];
  return !!array.find((v) => {
    return !!v.address?.includes("@hoie.kim");
  });
};
