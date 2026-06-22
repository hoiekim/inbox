import { Account } from "common";

/**
 * Build the account list for the Saved Mails view. A starred mail can live
 * in either the received or the sent folder, so the Saved view must union
 * both — otherwise a starred *sent* mail's account never appears and the
 * mail is unreachable from the collection it belongs to (#568).
 *
 * An address can be both a sent and a received account, so entries are
 * merged by key (one tag per account) and their saved/doc counts summed,
 * keeping the sort-by-size ordering correct.
 */
export const mergeSavedAccounts = (
  received: Account[],
  sent: Account[]
): Account[] => {
  const byKey = new Map<string, Account>();
  for (const account of [...received, ...sent]) {
    if (!account.saved_doc_count) continue;
    const existing = byKey.get(account.key);
    if (existing) {
      existing.saved_doc_count += account.saved_doc_count;
      existing.doc_count += account.doc_count;
    } else {
      byKey.set(account.key, new Account({ ...account }));
    }
  }
  return [...byKey.values()];
};
