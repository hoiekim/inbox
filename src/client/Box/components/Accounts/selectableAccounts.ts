import { Account } from "common";
import { Category } from "client";
import { mergeSavedAccounts } from "./savedAccounts";

export interface AccountLists {
  received?: Account[];
  sent?: Account[];
  spam?: Account[];
}

/**
 * The accounts the sidebar actually lists for `category` — i.e. the set a
 * selection has to belong to for a row to highlight and the mail pane to have
 * anything to render.
 *
 * Selectability is per-category, not union-wide: an address can hold sent mail
 * while holding no received mail, so it appears under Sent Mails and nowhere
 * else. Judging it against the union would call a selection valid on a
 * category whose list does not contain it, which is the phantom-account state
 * of #786 — a dead name in the header over "No emails in this account.".
 *
 * `Category.Search` has no list: there `selectedAccount` holds the live search
 * term rather than a key, so callers handle it before consulting this.
 */
export const accountsForCategory = (
  category: Category,
  { received = [], sent = [], spam = [] }: AccountLists
): Account[] => {
  if (category === Category.SentMails) return sent;
  if (category === Category.NewMails)
    return received.filter((a) => a.unread_doc_count);
  if (category === Category.SavedMails) return mergeSavedAccounts(received, sent);
  if (category === Category.SpamMails) return spam;
  return received;
};
