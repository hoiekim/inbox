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
 * `is_spam = FALSE` and the spam view filters `sent = FALSE`. Of the client's
 * views only Search, which filters neither, still finds it.
 *
 * The sender address cannot decide this. Inbound SMTP does not authenticate
 * `From`, so a remote sender can put the user's own domain there and a forged
 * inbound mail is then indistinguishable *by sender address* from a genuine
 * self-addressed copy. `sent` is decided by the server from the lane the mail
 * arrived on — hardcoded on the MX path, taken from the destination mailbox on
 * IMAP — so no remote sender can reach it.
 *
 * The spam view answers `true` unconditionally: there the action un-marks, which
 * moves a mail into a view that lists it rather than out of every view that
 * does. That keeps the un-mark path open even for a payload that stamps
 * `sent: true` on a mail the spam view is rendering — a value the view's own
 * `sent = FALSE` predicate contradicts, and which would otherwise strand the
 * mail in spam with no control to bring it back.
 */
export const canMarkSpam = (
  mail: Pick<MailHeaderData, "sent">,
  category: Category
): boolean => {
  if (category === Category.SpamMails) return true;
  return !mail.sent;
};
