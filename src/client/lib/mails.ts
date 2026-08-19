import { MailHeaderData } from "common";

export const isSentMail = (
  mail: Pick<MailHeaderData, "from">,
  userDomain: string
): boolean => {
  if (!userDomain) return false;
  const fromAddress = mail.from?.value?.[0]?.address;
  if (!fromAddress) return false;
  return fromAddress.toLowerCase().endsWith(`@${userDomain.toLowerCase()}`);
};
