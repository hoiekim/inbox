import { Account, SignedUser } from "common";
import { getAccountStats } from "../postgres/repositories/mails";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
}

export const getAccounts = async (
  user: SignedUser
): Promise<AccountsGetResponse> => {
  const [receivedStats, sentStats] = await Promise.all([
    getAccountStats(user.id, false),
    getAccountStats(user.id, true),
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
      updated: stat.latest,
    });
  });

  return { received, sent };
};
