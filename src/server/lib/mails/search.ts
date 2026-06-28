import { MailHeaderData, SignedUser, MailAddressValueType, Insight } from "common";
import { searchMails, SearchMailModel } from "../postgres/repositories/mails";

export const searchMail = async (
  user: SignedUser,
  value: string,
  field?: string
): Promise<MailHeaderData[]> => {
  // Clean search value - less aggressive since we use plainto_tsquery
  value = value.trim();
  if (!value) return [];

  const mailModels = await searchMails(user.id, value, field);

  // `sent` is intentionally NOT forwarded into MailHeaderData. The column is
  // deprecated (#430); sent/received state is derived from the sender address
  // against the user's domain. See MailHeaderDataType.sent for context.
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
      saved: m.saved,
      insight: m.insight as Insight | undefined,
      cc: m.cc_address
        ? { value: m.cc_address as MailAddressValueType[], text: m.cc_text || "" }
        : undefined,
      bcc: m.bcc_address
        ? { value: m.bcc_address as MailAddressValueType[], text: m.bcc_text || "" }
        : undefined,
      highlight: m.highlight,
    });
  });
};
