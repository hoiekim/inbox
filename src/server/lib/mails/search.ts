import { MailSearchResult, SignedUser, Pagination } from "common";
import { elasticsearchClient, index } from "server";

export const searchMail = async (
  user: SignedUser,
  value: string,
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
  const fields = field ? [field] : ["mail.subject", "mail.text"];
  fields.forEach((e, i) => {
    highlight.fields[e] = {};
    fields[i] += "^" + (fields.length - i);
  });

  const { from, size } = new Pagination();

  type SearchReturn = Omit<Omit<MailSearchResult, "id">, "highlight">;

  const searchResultKeys: (keyof SearchReturn)[] = [
    "subject",
    "date",
    "from",
    "to",
    "read"
  ];

  const response = await elasticsearchClient.search<{ mail: SearchReturn }>({
    index,
    from,
    size,
    _source: searchResultKeys.map((k) => `mail.${k}`),
    query: {
      bool: {
        must: [
          { term: { type: "mail" } },
          { term: { "user.id": user.id } },
          { query_string: { fields, query: value } }
        ]
      }
    },
    highlight
  });

  return response.hits.hits
    .map((e): MailSearchResult | undefined => {
      const { _id, _source } = e;
      const mail = _source?.mail;
      if (!mail) return;
      const { read, date, from, to, subject } = mail;
      return {
        id: _id,
        subject,
        date,
        from,
        to,
        read,
        highlight: e.highlight
      };
    })
    .filter((m): m is MailSearchResult => !!m);
};
