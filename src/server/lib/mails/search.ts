import {
  MailSearchResult,
  Pagination,
  elasticsearchClient,
  getUserDomain,
  index
} from "server";

export const searchMail = async (
  value: string,
  username: string,
  field?: string
): Promise<MailSearchResult[]> => {
  value = value.replace(/</g, "").replace(/>/g, "");

  const pattern = /([\!\*\+\-\=\<\>\&\|\(\)\[\]\{\}\^\~\?\:\\/"])/g;
  value = value.replace(pattern, "\\$1");

  value = value
    .split(" ")
    .map((e) => "*" + e + "*")
    .join(" ");

  const highlight: any = { fields: {} };
  const fields = field ? [field] : ["subject", "text"];
  fields.forEach((e, i) => {
    highlight.fields[e] = {};
    fields[i] += "^" + (fields.length - i);
  });

  const userDomain = getUserDomain(username);

  const { from, size } = new Pagination();

  type SearchReturn = Omit<Omit<MailSearchResult, "id">, "highlight">;

  const searchResultKeys: (keyof SearchReturn)[] = [
    "subject",
    "date",
    "from",
    "to",
    "read"
  ];

  const response = await elasticsearchClient.search<SearchReturn>({
    index,
    from,
    size,
    _source: searchResultKeys,
    query: {
      bool: {
        must: [
          { query_string: { fields, query: value } },
          {
            query_string: {
              default_field: "envelopeTo.address",
              query: `*@${userDomain}`
            }
          }
        ]
      }
    },
    highlight
  });

  return response.hits.hits.map((e) => {
    const { _id, _source } = e;
    const source = _source as SearchReturn;
    const { read, date, from, to, subject } = source;
    return {
      id: _id,
      subject,
      date,
      from,
      to,
      read,
      highlight: e.highlight
    };
  });
};
