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
 * The `selectedAccount` the current category requires, or `null` when nothing
 * has to change.
 *
 * Deciding validity and the fallback together is what keeps the caller
 * loop-free: the only value ever returned is a member of the category's own
 * list, and a member is accepted on the next pass.
 *
 * A category listing nothing resolves to `null` rather than clearing. The
 * sidebar reads "This category is empty" either way, so clearing buys nothing
 * and costs a real selection — the trip back to a populated category would
 * re-anchor to its first account instead of the one the user chose. It also
 * covers the payload the accounts route answers `success` with when its stats
 * queries fail: three empty lists, which read as "this user owns no address"
 * would let a transient server error erase a live selection. A partial failure
 * — one bucket empty while the others return — is still indistinguishable from
 * truth here.
 */
export const resolveSelectedAccount = (
  selectedAccount: string,
  category: Category,
  lists: AccountLists
): string | null => {
  if (category === Category.Search) return null;

  const listed = accountsForCategory(category, lists);
  if (!listed.length) return null;
  if (selectedAccount && listed.some((a) => a.key === selectedAccount)) {
    return null;
  }

  return listed[0].key;
};

/**
 * The category whose list hosts `accountKey`, for a jump made outside the
 * category tabs.
 *
 * The search side-tab is fed by a query that spans spam as well as the
 * spam-excluded received mail, so an address whose only match is spam is
 * listed there and absent from `received`. Landing that click on All Mails
 * would select a name that category cannot host, and the anchor would move it
 * straight off the account the user clicked.
 */
export const categoryForAccount = (
  accountKey: string,
  lists: AccountLists
): Category => {
  const hosting = [
    Category.AllMails,
    Category.SpamMails,
    Category.SentMails
  ].find((category) =>
    accountsForCategory(category, lists).some((a) => a.key === accountKey)
  );
  return hosting ?? Category.AllMails;
};
