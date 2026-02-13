import { MailHeaderData, SignedUser, Pagination, MaskedUser } from "common";
import {
  searchMails,
  getDomainUidNext as pgGetDomainUidNext,
  getAccountUidNext as pgGetAccountUidNext,
} from "../postgres/repositories/mails";

export const searchMail = async (
  user: SignedUser,
  value: string,
  field?: string
): Promise<MailHeaderData[]> => {
  // Clean search value
  value = value.replace(/</g, "").replace(/>/g, "");
  const pattern = /([\!\*\+\-\=\<\>\&\|\(\)\[\]\{\}\^\~\?\:\\/"])/g;
  value = value.replace(pattern, "\\$1");

  const mailModels = await searchMails(user.id, value, field);

  return mailModels.map((m) => {
    return new MailHeaderData({
      id: m.mail_id,
      subject: m.subject,
      date: m.date,
      from: m.from_address
        ? { value: m.from_address as any, text: m.from_text || "" }
        : undefined,
      to: m.to_address
        ? { value: m.to_address as any, text: m.to_text || "" }
        : undefined,
      read: m.read,
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
