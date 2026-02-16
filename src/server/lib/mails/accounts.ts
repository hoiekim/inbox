import { Account, SignedUser } from "common";
import { getAccountStats } from "../postgres/repositories/mails";
import { getUserDomain } from "./util";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
}

export const getAccounts = async (
  user: SignedUser
): Promise<AccountsGetResponse> => {
  const userDomain = getUserDomain(user.username);

  const [receivedStats, sentStats] = await Promise.all([
    getAccountStats(user.id, false),
    getAccountStats(user.id, true),
  ]);

  // Filter to only show accounts under the user's domain
  const received = receivedStats
    .filter((stat) => stat.address?.endsWith(`@${userDomain}`))
    .map((stat) => {
      return new Account({
        key: stat.address,
        doc_count: stat.count,
        unread_doc_count: stat.unread,
        saved_doc_count: stat.saved,
        updated: stat.latest,
      });
    });

  const sent = sentStats
    .filter((stat) => stat.address?.endsWith(`@${userDomain}`))
    .map((stat) => {
      return new Account({
        key: stat.address,
        doc_count: stat.count,
        updated: stat.latest,
      });
    });

  return { received, sent };
};
