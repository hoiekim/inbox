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
 * Spam is a received-mail concept: `is_spam = TRUE` on a mail with
 * `sent = TRUE` is listed by no web view at all — every non-spam view filters
 * `is_spam = FALSE` and the spam view filters `sent = FALSE` — so offering the
 * toggle on sent mail strands it with no un-mark path.
 *
 * The sender address cannot decide this. Inbound SMTP does not authenticate
 * `From`, so a remote sender can forge the user's own domain, and the header
 * payload of a forged inbound mail is identical to that of a genuine
 * self-addressed copy. The spam view is the one view that does not need the
 * guess: its server query already excludes sent mail, so everything it renders
 * is received. Elsewhere the sender address remains the only available signal.
 */
export const canMarkSpam = (
  mail: Pick<MailHeaderData, "from">,
  userDomain: string,
  category: Category
): boolean => {
  if (category === Category.SpamMails) return true;
  return !isSentMail(mail, userDomain);
};
