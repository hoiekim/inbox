import { MailHeaderData } from "common";

/**
 * Detects whether `mail` was sent by the user, by comparing the sender
 * address against the user's domain. This is the canonical way to derive
 * sent/received state — see #430 / #509 for the rationale (the `sent`
 * column on the `mails` table is deprecated; do not branch on `mail.sent`).
 */
export const isSentMail = (
  mail: Pick<MailHeaderData, "from">,
  userDomain: string
): boolean => {
  if (!userDomain) return false;
  const fromAddress = mail.from?.value?.[0]?.address;
  if (!fromAddress) return false;
  return fromAddress.toLowerCase().endsWith(`@${userDomain.toLowerCase()}`);
};
