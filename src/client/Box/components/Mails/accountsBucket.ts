import { Account, MailAddressType, MailHeaderData } from "common";
import { AccountsGetResponse } from "server";
import { Category } from "client";

export type AccountsBucket = "received" | "sent" | "spam";

// `value` arrives as a bare object rather than a one-element array for some
// rows, which is why the header component normalizes cc and bcc before reading
// them; this runs from a click handler on whatever the payload held.
const holdsAddress = (
  addresses: MailAddressType | undefined,
  accountKey: string
): boolean => {
  const value = addresses?.value;
  if (!value) return false;
  const list = Array.isArray(value) ? value : [value];
  return list.some((e) => e.address === accountKey);
};

/**
 * The account lists whose counters a mail contributes to for `accountKey`.
 *
 * Which lists a mail counts towards is a property of the mail, not of the view
 * it was acted on from: the server groups `sent` by `from_address` and
 * `received` by the recipient headers, so an account that both sent a mail and
 * was copied on it is counted in both, and two edits made from two categories
 * have to agree or a star and its unstar stop cancelling. `mail.sent` cannot
 * stand in for the sender test — it says the user sent the mail, not that this
 * account is the address it went out from.
 *
 * The category answers only what the payload cannot. `is_spam` is not a header
 * field and a spam mail is counted in `spam` alone. `envelope_to` is one of the
 * columns the received condition matches on and no header column carries it, so
 * for a mail the account also sent, the received side is settled by the query
 * that returned the row: a category listing received mail proves it matched.
 */
export const bucketsForMail = (
  category: Category,
  mail: MailHeaderData,
  accountKey: string
): AccountsBucket[] => {
  if (category === Category.Search) return [];
  if (category === Category.SpamMails) return ["spam"];

  const listedByRecipientCondition =
    category === Category.AllMails || category === Category.NewMails;
  const isSender = holdsAddress(mail.from, accountKey);
  const isRecipient =
    listedByRecipientCondition ||
    !isSender ||
    [mail.to, mail.cc, mail.bcc].some((e) => holdsAddress(e, accountKey));

  const buckets: AccountsBucket[] = [];
  if (isRecipient) buckets.push("received");
  if (isSender) buckets.push("sent");
  return buckets;
};

/**
 * The list `category` shows whole, or `null` when it shows a filtered view of
 * one — the test for whether an emptied sidebar list means the account left a
 * bucket.
 *
 * New Mails and Saved Mails are `unread_doc_count` / `saved_doc_count` filters
 * over the buckets they draw from, so one of those lists running empty means a
 * counter reached zero, not that the account left the bucket: it still holds
 * the mail behind the other counters. Search shows no bucket at all, since
 * `selectedAccount` carries the search term there rather than an account key.
 */
export const wholeBucketForCategory = (
  category: Category
): AccountsBucket | null => {
  if (category === Category.AllMails) return "received";
  if (category === Category.SentMails) return "sent";
  if (category === Category.SpamMails) return "spam";
  return null;
};

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
): AccountsGetResponse => {
  const bucket = wholeBucketForCategory(category);
  return bucket ? removeAccountFromBucket(data, bucket, key) : data;
};
