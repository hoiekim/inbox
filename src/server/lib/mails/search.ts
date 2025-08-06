import { MailHeaderData, SignedUser, Pagination, MaskedUser } from "common";
import {
  elasticsearchClient,
  FROM_ADDRESS_FIELD,
  index,
  TO_ADDRESS_FIELD
} from "server";

export const searchMail = async (
  user: SignedUser,
  value: string,
  field?: string
): Promise<MailHeaderData[]> => {
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

  type SearchReturn = Omit<MailHeaderData, "id" | "highlight">;

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
    .map((e): MailHeaderData | undefined => {
      const { _id, _source } = e;
      const mail = _source?.mail;
      if (!mail) return;
      const { read, date, from, to, subject } = mail;
      return new MailHeaderData({
        id: _id,
        subject,
        date,
        from,
        to,
        read,
        highlight: e.highlight
      });
    })
    .filter((m): m is MailHeaderData => !!m);
};

interface MaxUidAggregation {
  maxUid: { value: number };
}

export const getDomainUidNext = async (
  user: MaskedUser,
  sent: boolean = false
): Promise<number | null> => {
  try {
    const response = await elasticsearchClient.search<MaxUidAggregation>({
      index,
      size: 0,
      query: {
        bool: {
          must: [
            { term: { type: "mail" } },
            { term: { "user.id": user.id } },
            { term: { "mail.sent": sent } }
          ]
        }
      },
      aggs: { maxUid: { max: { field: "mail.uid.domain" } } }
    });

    return (response.aggregations?.maxUid?.value ?? 0) + 1;
  } catch (error) {
    console.error("Error getting next UID:", error);
    return 1;
  }
};

export const getAccountUidNext = async (
  user: MaskedUser,
  account: string,
  sent: boolean = false
): Promise<number | null> => {
  try {
    const addressField = sent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

    const response = await elasticsearchClient.search<MaxUidAggregation>({
      index,
      size: 0,
      query: {
        bool: {
          must: [
            { term: { type: "mail" } },
            { term: { "user.id": user.id } },
            { term: { [addressField]: account } },
            { term: { "mail.sent": sent } }
          ]
        }
      },
      aggs: { maxUid: { max: { field: "mail.uid.account" } } }
    });

    return (response.aggregations?.maxUid?.value ?? 0) + 1;
  } catch (error) {
    console.error("Error getting next UID:", error);
    return 1;
  }
};
