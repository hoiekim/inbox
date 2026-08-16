import { Account } from "common";

/**
 * Whether `key` names an account the sidebar can actually select.
 *
 * `received`, `sent` and `spam` are the whole universe: the Saved view's list
 * is derived from received + sent (`mergeSavedAccounts`), so it adds no key of
 * its own. A stored `selectedAccount` outside this set is unreachable state —
 * a search term left in the slot, or an account the server stopped returning
 * once its last mail was deleted (#786).
 */
export const isSelectableAccount = (
  key: string,
  accounts: { received?: Account[]; sent?: Account[]; spam?: Account[] }
): boolean => {
  const { received = [], sent = [], spam = [] } = accounts;
  return (
    received.some((a) => a.key === key) ||
    sent.some((a) => a.key === key) ||
    spam.some((a) => a.key === key)
  );
};
