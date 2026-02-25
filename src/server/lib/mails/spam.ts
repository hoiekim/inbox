/**
 * Spam-related mail operations
 */

import { MailHeaderData, MaskedUser } from "common";
import { getSpamMails, markMailSpam } from "../postgres/repositories/mails";

/**
 * Get spam mail headers for a user.
 * Returns mail headers for display in a spam folder view.
 */
export const getSpamHeaders = async (
  user: MaskedUser
): Promise<MailHeaderData[]> => {
  if (!user.id) return [];
  const mails = await getSpamMails(user.id);
  
  return mails.map((m) => {
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
      cc: m.cc_address
        ? { value: m.cc_address as any, text: m.cc_text || "" }
        : undefined,
      bcc: m.bcc_address
        ? { value: m.bcc_address as any, text: m.bcc_text || "" }
        : undefined,
      read: m.read,
      saved: m.saved,
      insight: m.insight as any,
    });
  });
};

/**
 * Mark or unmark a mail as spam.
 * Authorization is enforced at the repository layer via user_id in WHERE clause.
 */
export const markSpam = async (
  user_id: string,
  mail_id: string,
  is_spam: boolean
): Promise<boolean> => {
  return markMailSpam(user_id, mail_id, is_spam);
};
