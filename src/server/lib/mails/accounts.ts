import { Account, SignedUser } from "common";
import {
  getAccountStats,
  searchAccountStats,
} from "../postgres/repositories/mails";
import { getUserDomain } from "server";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
}

export const getAccounts = async (
  user: SignedUser
): Promise<AccountsGetResponse> => {
  const userDomain = getUserDomain(user.username);

  const [receivedStats, sentStats] = await Promise.all([
    getAccountStats(user.id, false, userDomain),
    getAccountStats(user.id, true, userDomain),
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

  return { received, sent };
};

// Received accounts that own at least one mail matching `value`. Backs the
// search side-tab: the user types a keyword, this lists the accounts whose mail
// appears in the results, and clicking one jumps to that account's All view.
export const searchAccounts = async (
  user: SignedUser,
  value: string
): Promise<Account[]> => {
  value = value.trim();
  if (!value) return [];

  const userDomain = getUserDomain(user.username);
  const stats = await searchAccountStats(user.id, value, userDomain);

  return stats.map((stat) => {
    return new Account({
      key: stat.address,
      doc_count: stat.count,
      unread_doc_count: stat.unread,
      saved_doc_count: stat.saved,
      updated: stat.latest,
    });
  });
};
