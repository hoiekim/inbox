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
 * Whether any list holds `accountKey` — the test for whether the name refers to
 * a real account at all, as opposed to whether the current category shows it.
 */
const isKnownAccount = (
  accountKey: string,
  { received = [], sent = [], spam = [] }: AccountLists
): boolean =>
  [received, sent, spam].some((list) =>
    list.some((a) => a.key === accountKey)
  );

/**
 * The `selectedAccount` the current category requires, `""` to clear a name no
 * list holds, or `null` when nothing has to change.
 *
 * Realness and listing are separate tests, and collapsing them into one loses a
 * case either way. A name every list agrees is absent is unreachable state — a
 * search term left behind by a reload, or an account whose last mail was
 * deleted — and it has to go, or the header renders it over an empty pane with
 * no affordance to recover. A real account the current category cannot show is
 * a selection rather than a phantom: keep it, so the trip back to a category
 * that lists it lands where the user left off instead of on its first row.
 *
 * Deciding validity and the fallback together is what keeps the caller
 * loop-free: the only account ever returned is a member of the category's own
 * list, and a member is accepted on the next pass.
 *
 * A payload holding no accounts at all is indistinguishable from the one the
 * accounts route answers `success` with when its stats queries fail, so
 * clearing there can drop a live selection on a transient error. It clears
 * anyway: that costs one selection and rights itself on the next payload,
 * whereas keeping it strands the user who just deleted their only account's
 * last mail, with nothing left to click.
 */
export const resolveSelectedAccount = (
  selectedAccount: string,
  category: Category,
  lists: AccountLists
): string | null => {
  if (category === Category.Search) return null;

  const listed = accountsForCategory(category, lists);
  if (selectedAccount && listed.some((a) => a.key === selectedAccount)) {
    return null;
  }

  if (!listed.length) {
    if (!selectedAccount || isKnownAccount(selectedAccount, lists)) return null;
    return "";
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
