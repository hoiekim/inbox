import {
  elasticsearchClient,
  index,
  MailHeaderData,
  FROM_ADDRESS_FIELD,
  TO_ADDRESS_FIELD,
  Pagination
} from "server";

export interface GetMailsOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  pagination?: Pagination;
}

export const getMailHeaders = async (
  address: string,
  options: GetMailsOptions
): Promise<MailHeaderData[]> => {
  let searchFiled, query;

  if (options.sent) searchFiled = FROM_ADDRESS_FIELD;
  else searchFiled = TO_ADDRESS_FIELD;

  const queryByAddress = { term: { [searchFiled]: address } };

  if (options.new) {
    query = { bool: { must: [queryByAddress, { term: { read: false } }] } };
  } else if (options.saved) {
    query = { bool: { must: [queryByAddress, { term: { label: "saved" } }] } };
  } else {
    query = queryByAddress;
  }

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

  const response = await elasticsearchClient.search<{ mail: SearchReturn }>({
    index,
    _source: mailHeaderKeys.map((k) => `mail.${k}`),
    from,
    size,
    query,
    sort: { date: "desc" }
  });

  return response.hits.hits
    .map(({ _id, _source }): MailHeaderData | undefined => {
      const mail = _source?.mail;
      return mail && { id: _id, ...mail };
    })
    .filter((m): m is MailHeaderData => !!m);
};
