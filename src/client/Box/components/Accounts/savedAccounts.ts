import { Account } from "common";

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
