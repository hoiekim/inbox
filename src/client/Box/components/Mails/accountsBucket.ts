import { Account, MailAddressType, MailHeaderData } from "common";
import { AccountsGetResponse } from "server";
import { Category } from "client";

export type AccountsBucket = "received" | "sent" | "spam";

/**
 * The account lists `category` draws its mail from.
 *
 * Most categories name exactly one. Saved Mails names two — its rows are
 * `(from_address matches OR a recipient header matches)`, so it lists sent and
 * received mail side by side — and Search names none, since `selectedAccount`
 * carries the search term there rather than an account key.
 */
export const bucketsForCategory = (category: Category): AccountsBucket[] => {
  if (category === Category.Search) return [];
  if (category === Category.SentMails) return ["sent"];
  if (category === Category.SpamMails) return ["spam"];
  if (category === Category.SavedMails) return ["received", "sent"];
  return ["received"];
};

const holdsAddress = (
  addresses: MailAddressType | undefined,
  accountKey: string
): boolean => !!addresses?.value?.some((e) => e.address === accountKey);

/**
 * The lists holding the counters a mail shown under `category` contributes to
 * for `accountKey`. Only those are touched, so an address present in a list the
 * mail doesn't count towards isn't decremented.
 *
 * Where the category names two, the mail's own addresses pick between them: the
 * server groups `sent` by `from_address` and `received` by the recipient
 * headers, so an account that both sent and received a mail is counted in both.
 * `mail.sent` cannot stand in for the sender test — it says the user sent the
 * mail, not that this account is the address it went out from.
 */
export const bucketsForMail = (
  category: Category,
  mail: MailHeaderData,
  accountKey: string
): AccountsBucket[] => {
  const buckets = bucketsForCategory(category);
  if (category !== Category.SavedMails) return buckets;

  const isSender = holdsAddress(mail.from, accountKey);
  // A row this account didn't send is listed because a recipient header
  // matched, and `envelope_to` is one of those while the header payload omits
  // it — so absence from to/cc/bcc rules the received side out only for a mail
  // the account did send.
  const isRecipient =
    !isSender ||
    [mail.to, mail.cc, mail.bcc].some((e) => holdsAddress(e, accountKey));

  return buckets.filter((bucket) =>
    bucket === "sent" ? isSender : isRecipient
  );
};

/**
 * Whether `category` lists a whole bucket rather than a filtered view of one.
 *
 * New Mails and Saved Mails are `unread_doc_count` / `saved_doc_count` filters
 * over the buckets they draw from, so one of those lists running empty means a
 * counter reached zero — not that the account left the bucket. It still holds
 * the mail behind the other counters.
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

/** Applies the update in each named bucket, leaving every other list alone. */
export const updateAccountInBuckets = (
  data: AccountsGetResponse,
  buckets: AccountsBucket[],
  key: string,
  update: (account: Account) => Partial<Account>
): AccountsGetResponse =>
  buckets.reduce(
    (updated, bucket) => updateAccountInBucket(updated, bucket, key, update),
    data
  );

/** Drops the account from `bucket`, leaving the other lists untouched. */
export const removeAccountFromBucket = (
  data: AccountsGetResponse,
  bucket: AccountsBucket,
  key: string
): AccountsGetResponse => ({
  ...data,
  [bucket]: data[bucket].filter((account) => account.key !== key)
});

/**
 * Drops the account from the bucket `category` lists, or hands `data` back
 * untouched when the category only shows a filtered view of one — the emptied
 * list there is a counter reaching zero, not the account leaving the bucket.
 */
export const evictAccountFromCategory = (
  data: AccountsGetResponse,
  category: Category,
  key: string
): AccountsGetResponse =>
  listsWholeBucket(category)
    ? bucketsForCategory(category).reduce(
        (evicted, bucket) => removeAccountFromBucket(evicted, bucket, key),
        data
      )
    : data;
