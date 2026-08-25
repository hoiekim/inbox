import { Account } from "common";
import { AccountsGetResponse } from "server";
import { Category } from "client";

export type AccountsBucket = "received" | "sent" | "spam";

/**
 * The list holding the account whose counters a mail shown under `category`
 * contributes to. Only that one is touched, so an address present in more than
 * one list isn't double-decremented.
 */
export const bucketForCategory = (category: Category): AccountsBucket => {
  if (category === Category.SentMails) return "sent";
  if (category === Category.SpamMails) return "spam";
  return "received";
};

/**
 * Whether `category` lists a whole bucket rather than a filtered view of one.
 *
 * New Mails and Saved Mails are `unread_doc_count` / `saved_doc_count` filters
 * over `received`, so one of those lists running empty means a counter reached
 * zero — not that the account left the bucket. It still holds the mail behind
 * the other counters.
 */
export const listsWholeBucket = (category: Category): boolean =>
  category === Category.AllMails ||
  category === Category.SentMails ||
  category === Category.SpamMails;

/**
 * Replaces the matching account with an updated copy.
 *
 * Copies rather than mutating in place: react-query's structural sharing hands
 * back the previous `data` reference when every element is reference-equal, so
 * an in-place counter edit reaches the cache but notifies no observer — and
 * the accounts sidebar keeps rendering the stale count.
 */
export const updateAccountInBucket = (
  data: AccountsGetResponse,
  bucket: AccountsBucket,
  key: string,
  update: (account: Account) => Partial<Account>
): AccountsGetResponse => ({
  ...data,
  [bucket]: data[bucket].map((account) =>
    account.key === key
      ? new Account({ ...account, ...update(account) })
      : account
  )
});

/** Drops the account from `bucket`, leaving the other lists untouched. */
export const removeAccountFromBucket = (
  data: AccountsGetResponse,
  bucket: AccountsBucket,
  key: string
): AccountsGetResponse => ({
  ...data,
  [bucket]: data[bucket].filter((account) => account.key !== key)
});
