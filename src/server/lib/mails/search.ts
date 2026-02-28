import { MailHeaderData, SignedUser, MailAddressValueType } from "common";
import {
  searchMails,
  SearchMailModel,
  getDomainUidNext as pgGetDomainUidNext,
  getAccountUidNext as pgGetAccountUidNext,
} from "../postgres/repositories/mails";

export const searchMail = async (
  user: SignedUser,
  value: string,
  field?: string
): Promise<MailHeaderData[]> => {
  // Clean search value - less aggressive since we use plainto_tsquery
  value = value.trim();
  if (!value) return [];

  const mailModels = await searchMails(user.id, value, field);

  return mailModels.map((m: SearchMailModel) => {
    return new MailHeaderData({
      id: m.mail_id,
      subject: m.subject,
      date: m.date,
      from: m.from_address
        ? { value: m.from_address as MailAddressValueType[], text: m.from_text || "" }
        : undefined,
      to: m.to_address
        ? { value: m.to_address as MailAddressValueType[], text: m.to_text || "" }
        : undefined,
      read: m.read,
      highlight: m.highlight,
    });
  });
};

export const getDomainUidNext = async (
  userId: string,
  sent: boolean = false
): Promise<number | null> => {
  try {
    return await pgGetDomainUidNext(userId, sent);
  } catch (error) {
    console.error("Error getting next UID:", error);
    return 1;
  }
};

export const getAccountUidNext = async (
  userId: string,
  account: string,
  sent: boolean = false
): Promise<number | null> => {
  try {
    return await pgGetAccountUidNext(userId, account, sent);
  } catch (error) {
    console.error("Error getting next UID:", error);
    return 1;
  }
};
