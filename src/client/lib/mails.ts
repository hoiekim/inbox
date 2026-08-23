import { MailHeaderData } from "common";
import { Category } from "client";

export const isSentMail = (
  mail: Pick<MailHeaderData, "from">,
  userDomain: string
): boolean => {
  if (!userDomain) return false;
  const fromAddress = mail.from?.value?.[0]?.address;
  if (!fromAddress) return false;
  return fromAddress.toLowerCase().endsWith(`@${userDomain.toLowerCase()}`);
};

/**
 * Whether the spam toggle may be offered for a mail rendered in this view.
 *
 * Spam is a received-mail concept: marking a `sent = TRUE` mail leaves it in
 * none of the five list views, since each non-spam view filters
 * `is_spam = FALSE` and the spam view filters `sent = FALSE`. Only Search,
 * which filters neither, still finds it.
 *
 * The sender address cannot decide this. Inbound SMTP does not authenticate
 * `From`, so a remote sender can forge the user's own domain, and the header
 * payload of a forged inbound mail is identical to that of a genuine
 * self-addressed copy.
 *
 * The spam view needs no answer either way: there the action un-marks, which
 * moves a mail into a view that lists it rather than out of every view that
 * does. Elsewhere the sender address remains the only available signal.
 */
export const canMarkSpam = (
  mail: Pick<MailHeaderData, "from">,
  userDomain: string,
  category: Category
): boolean => {
  if (category === Category.SpamMails) return true;
  return !isSentMail(mail, userDomain);
};
