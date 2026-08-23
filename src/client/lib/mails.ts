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
 * Spam is a received-mail concept: `is_spam = TRUE` together with a sent mail
 * is listed by neither the Sent view nor the Spam view, so offering the toggle
 * on sent mail strands it with no un-mark path.
 *
 * `getMailsQueryUrl` scopes every category but Saved and Search to one side of
 * the mailbox — Sent by `from_address`, the rest by `to`/`cc`/`bcc`/
 * `envelope_to` — so those views settle sent-vs-received on their own. Only the
 * two that match both sides fall back to the sender address, which inbound SMTP
 * does not authenticate.
 */
export const canMarkSpam = (
  mail: Pick<MailHeaderData, "from">,
  userDomain: string,
  category: Category
): boolean => {
  if (category === Category.SentMails) return false;
  if (category === Category.SavedMails || category === Category.Search) {
    return !isSentMail(mail, userDomain);
  }
  return true;
};
