import {
  MailHeaderData,
  MaskedUser,
  Pagination,
  SignedUser,
  MailAddressValueType,
  Insight,
} from "common";
import {
  getMailHeaders as pgGetMailHeaders,
  GetMailHeadersOptions,
} from "../postgres/repositories/mails";

export interface GetMailsOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  pagination?: Pagination;
}

interface UserWithId {
  user_id?: string;
}

export const getMailHeaders = async (
  user: MaskedUser | SignedUser,
  address: string,
  options: GetMailsOptions
): Promise<MailHeaderData[]> => {
  const userId = "id" in user ? user.id : (user as UserWithId).user_id;
  if (!userId) return [];

  const { from, size } = options.pagination || new Pagination();

  const pgOptions: GetMailHeadersOptions = {
    sent: options.sent,
    new: options.new,
    saved: options.saved,
    from,
    size,
  };

  const mailModels = await pgGetMailHeaders(userId, address, pgOptions);

  return mailModels.map((m) => {
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
      cc: m.cc_address
        ? { value: m.cc_address as MailAddressValueType[], text: m.cc_text || "" }
        : undefined,
      bcc: m.bcc_address
        ? { value: m.bcc_address as MailAddressValueType[], text: m.bcc_text || "" }
        : undefined,
      read: m.read,
      saved: m.saved,
      insight: m.insight as Insight | undefined,
    });
  });
};
