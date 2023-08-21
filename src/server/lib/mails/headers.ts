import { QueryDslQueryContainer } from "@elastic/elasticsearch/lib/api/types";
import {
  elasticsearchClient,
  index,
  FROM_ADDRESS_FIELD,
  TO_ADDRESS_FIELD
} from "server";
import { MailHeaderData, MaskedUser, Pagination } from "common";

export interface GetMailsOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  pagination?: Pagination;
}

export const getMailHeaders = async (
  user: MaskedUser,
  address: string,
  options: GetMailsOptions
): Promise<MailHeaderData[]> => {
  const searchFiled = options.sent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

  const { from, size } = options.pagination || new Pagination();

  type SearchReturn = Omit<MailHeaderData, "id">;

  const mailHeaderKeys: (keyof SearchReturn)[] = [
    "read",
    "date",
    "subject",
    "from",
    "to",
    "cc",
    "bcc",
    "label",
    "insight"
  ];

  const must: QueryDslQueryContainer[] = [
    { term: { type: "mail" } },
    { term: { "user.id": user.id } },
    { term: { [searchFiled]: address } },
    { term: { "mail.sent": options.sent } }
  ];

  if (options.new) must.push({ term: { "mail.read": false } });
  else if (options.saved) must.push({ term: { "mail.saved": true } });

  const response = await elasticsearchClient.search({
    index,
    _source: mailHeaderKeys.map((k) => `mail.${k}`),
    from,
    size,
    query: { bool: { must } },
    sort: { "mail.date": "desc" }
  });

  return response.hits.hits
    .map(({ _id, _source }): MailHeaderData | undefined => {
      const mail = _source?.mail;
      return mail && new MailHeaderData({ id: _id, ...mail });
    })
    .filter((m): m is MailHeaderData => !!m);
};
