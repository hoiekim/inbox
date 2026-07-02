import { Account, SignedUser } from "common";
import { getAccountStats, getSpamUnreadCount } from "../postgres/repositories/mails";
import { getUserDomain } from "server";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
  // Spam is user-global (no per-account breakdown), so its unread badge rides
  // on the accounts payload — already fetched on load — instead of a separate
  // full-list fetch just to count.
  spamUnreadCount: number;
}

export const getAccounts = async (
  user: SignedUser
): Promise<AccountsGetResponse> => {
  const userDomain = getUserDomain(user.username);

  const [receivedStats, sentStats, spamUnreadCount] = await Promise.all([
    getAccountStats(user.id, false, userDomain),
    getAccountStats(user.id, true, userDomain),
    getSpamUnreadCount(user.id),
  ]);

  const received = receivedStats.map((stat) => {
    return new Account({
      key: stat.address,
      doc_count: stat.count,
      unread_doc_count: stat.unread,
      saved_doc_count: stat.saved,
      updated: stat.latest,
    });
  });

  const sent = sentStats.map((stat) => {
    return new Account({
      key: stat.address,
      doc_count: stat.count,
      unread_doc_count: stat.unread,
      saved_doc_count: stat.saved,
      updated: stat.latest,
    });
  });

  return { received, sent, spamUnreadCount };
};
