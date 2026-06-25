import {
  MailHeaderData,
  MaskedUser,
  Pagination,
  SignedUser,
  MailAddressValueType,
  Insight,
} from "common";
import {
  getMailHeaders as pgGetMailHeaders,
  getMailHeadersDelta as pgGetMailHeadersDelta,
  GetMailHeadersOptions,
  MailHeaderResult,
} from "../postgres/repositories/mails";

export interface GetMailsOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  pagination?: Pagination;
}

export interface MailHeadersDelta {
  as_of: string;
  headers: MailHeaderData[];
  expunged_ids: string[];
}

interface UserWithId {
  user_id?: string;
}

const resolveUserId = (user: MaskedUser | SignedUser): string | undefined =>
  "id" in user ? user.id : (user as UserWithId).user_id;

const toMailHeaderData = (m: MailHeaderResult): MailHeaderData =>
  new MailHeaderData({
    id: m.mail_id,
    subject: m.subject,
    date: m.date,
    from: m.from_address
      ? { value: m.from_address as MailAddressValueType[], text: m.from_text || "" }
      : undefined,
    to: m.to_address
      ? { value: m.to_address as MailAddressValueType[], text: m.to_text || "" }
      : undefined,
    cc: m.cc_address
      ? { value: m.cc_address as MailAddressValueType[], text: m.cc_text || "" }
      : undefined,
    bcc: m.bcc_address
      ? { value: m.bcc_address as MailAddressValueType[], text: m.bcc_text || "" }
      : undefined,
    read: m.read,
    saved: m.saved,
    sent: m.sent,
    insight: m.insight as Insight | undefined,
  });

export const getMailHeaders = async (
  user: MaskedUser | SignedUser,
  address: string,
  options: GetMailsOptions
): Promise<MailHeaderData[]> => {
  const userId = resolveUserId(user);
  if (!userId) return [];

  const { from, size } = options.pagination || new Pagination();

  const pgOptions: GetMailHeadersOptions = {
    sent: options.sent,
    new: options.new,
    saved: options.saved,
    from,
    size,
  };

  const mailModels = await pgGetMailHeaders(userId, address, pgOptions);

  return mailModels.map(toMailHeaderData);
};

// Incremental fetch for the IndexedDB cache (#457): only rows changed since
// `since`, plus tombstones (ids of rows expunged in the window) for eviction,
// and `as_of` for the client to persist as the next cursor.
export const getMailHeadersDelta = async (
  user: MaskedUser | SignedUser,
  address: string,
  options: GetMailsOptions,
  since: string
): Promise<MailHeadersDelta> => {
  const userId = resolveUserId(user);
  if (!userId) return { as_of: since, headers: [], expunged_ids: [] };

  const pgOptions: GetMailHeadersOptions = {
    sent: options.sent,
    new: options.new,
    saved: options.saved,
  };

  const { as_of, headers, expunged_ids } = await pgGetMailHeadersDelta(
    userId,
    address,
    pgOptions,
    since
  );

  return { as_of, headers: headers.map(toMailHeaderData), expunged_ids };
};
