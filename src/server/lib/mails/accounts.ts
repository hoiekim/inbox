import {
  AggregationsStringTermsBucket,
  AggregationsTermsAggregateBase,
  SearchResponseBody
} from "@elastic/elasticsearch/lib/api/types";

import {
  FROM_ADDRESS_FIELD,
  Document,
  elasticsearchClient,
  getUserDomain,
  index,
  TO_ADDRESS_FIELD,
  DateString,
  AccountsGetResponse
} from "server";

export class Account {
  key: string;
  updated: Date;
  doc_count = 0;
  unread_doc_count = 0;
  saved_doc_count = 0;

  constructor(init: Partial<Account> & { key: string; updated: Date }) {
    this.key = init.key;
    this.updated = init.updated;
    if (init.doc_count) this.doc_count = init.doc_count;
    if (init.unread_doc_count) this.unread_doc_count = init.unread_doc_count;
    if (init.saved_doc_count) this.saved_doc_count = init.saved_doc_count;
  }
}

interface AddressAggregation {
  address: AggregationsTermsAggregateBase<AddressAggregationBucket>;
}

type AddressAggregationBucket = AggregationsStringTermsBucket & {
  read?: AggregationsTermsAggregateBase<AggregationsStringTermsBucket>;
  label?: AggregationsTermsAggregateBase<AggregationsStringTermsBucket>;
  updated: { value: DateString };
};

export const getAccounts = async (
  username: string
): Promise<AccountsGetResponse> => {
  const userDomain = getUserDomain(username);

  const response = await elasticsearchClient.msearch<
    Document,
    AddressAggregation
  >({
    index,
    searches: [
      // Query1: Accounts that have received mails
      {},
      {
        size: 0,
        query: {
          query_string: {
            default_field: TO_ADDRESS_FIELD,
            query: `*@${userDomain}`
          }
        },
        aggs: {
          address: {
            terms: {
              field: TO_ADDRESS_FIELD,
              size: 10000,
              order: { updated: "desc" }
            },
            aggs: {
              updated: { max: { field: "date" } },
              read: { terms: { field: "read", size: 10000 } },
              label: { terms: { field: "label", size: 10000 } }
            }
          }
        }
      },
      // Query2: Accounts that have sent mails
      {},
      {
        size: 0,
        query: {
          query_string: {
            default_field: FROM_ADDRESS_FIELD,
            query: `*@${userDomain}`
          }
        },
        aggs: {
          address: {
            terms: { field: FROM_ADDRESS_FIELD, size: 10000 },
            aggs: { updated: { max: { field: "date" } } }
          }
        }
      }
    ]
  });

  const [receivedMailsResponse, sentMailsResponse] = response.responses.map(
    (e) => {
      if ("error" in e) throw new Error(JSON.stringify(e.error));
      // Needs type casting due to Elasticsearch client bug
      // https://github.com/elastic/elasticsearch-js/issues/1937
      const response = e as SearchResponseBody<Document, AddressAggregation>;
      if (!response.aggregations?.address) return [];
      const { address } = response.aggregations;
      if (!("buckets" in address)) return [];
      const { buckets } = address;
      if (!Array.isArray(buckets)) return [];
      return buckets;
    }
  );

  const received = receivedMailsResponse.map(convertAggregation);
  const sent = sentMailsResponse.map(convertAggregation);

  return { received, sent };
};

const convertAggregation = (aggregation: AddressAggregationBucket): Account => {
  const { key, doc_count } = aggregation;
  const updated = new Date(aggregation.updated.value);

  const account = new Account({ key, updated, doc_count });

  const readBuckets = aggregation.read?.buckets;
  const labelBuckets = aggregation.label?.buckets;

  if (Array.isArray(readBuckets)) {
    const unread_doc_count = readBuckets.find((b) => !b.key)?.doc_count;
    if (unread_doc_count) account.unread_doc_count = unread_doc_count;
  }

  if (Array.isArray(labelBuckets)) {
    const isSaved = (b: AggregationsStringTermsBucket) => b.key === "saved";
    const saved_doc_count = labelBuckets.find(isSaved)?.doc_count;
    if (saved_doc_count) account.saved_doc_count = saved_doc_count;
  }

  return account;
};
