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
 * category whose list does not contain it — a dead name in the header over
 * "No emails in this account.".
 *
 * `Category.Search` lists nothing: there `selectedAccount` carries the live
 * search term rather than an account key.
 */
export const accountsForCategory = (
  category: Category,
  { received = [], sent = [], spam = [] }: AccountLists
): Account[] => {
  if (category === Category.Search) return [];
  if (category === Category.SentMails) return sent;
  if (category === Category.NewMails)
    return received.filter((a) => a.unread_doc_count);
  if (category === Category.SavedMails)
    return mergeSavedAccounts(received, sent);
  if (category === Category.SpamMails) return spam;
  return received;
};

/**
 * The `selectedAccount` the current category requires, or `null` when the
 * stored one already belongs to it and nothing has to change.
 *
 * Deciding validity and the fallback in one place is what keeps the caller
 * loop-free. Split across two effects reading two different lists, each write
 * is rejected by the other on the next render whenever the current category
 * lists nothing.
 *
 * A payload holding no accounts at all resolves to `null`: the accounts route
 * answers `success` with three empty lists when its stats query fails, so
 * reading that as "this user owns no address" would let a transient server
 * error erase a selection that is about to be valid again.
 */
export const resolveSelectedAccount = (
  selectedAccount: string,
  category: Category,
  lists: AccountLists
): string | null => {
  if (category === Category.Search) return null;

  const { received = [], sent = [], spam = [] } = lists;
  if (!received.length && !sent.length && !spam.length) return null;

  const listed = accountsForCategory(category, lists);
  if (selectedAccount && listed.some((a) => a.key === selectedAccount)) {
    return null;
  }

  const resolved = listed.length ? listed[0].key : "";
  return resolved === selectedAccount ? null : resolved;
};
