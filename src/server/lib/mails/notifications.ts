import {
  AggregationsStringTermsBucket,
  AggregationsTermsAggregateBase
} from "@elastic/elasticsearch/lib/api/types";
import { DateString, Notifications, SignedUser } from "common";
import {
  addressToUsername,
  elasticsearchClient,
  index,
  TO_ADDRESS_FIELD
} from "server";

interface AddressAggregation {
  address: AggregationsTermsAggregateBase<AddressAggregationBucket>;
}

type AddressAggregationBucket = AggregationsStringTermsBucket & {
  read: AggregationsTermsAggregateBase<AggregationsStringTermsBucket>;
  latest: { value: DateString };
};

export const getNotifications = async (
  users: SignedUser[]
): Promise<Notifications> => {
  const matchUserIds = users.map((user) => {
    return { term: { "user.id": user.id } };
  });

  const response = elasticsearchClient.search<AddressAggregation>({
    index,
    size: 0,
    query: {
      bool: {
        must: [{ term: { type: "mail" } }, { bool: { should: matchUserIds } }]
      }
    },
    aggs: {
      address: {
        terms: { field: TO_ADDRESS_FIELD, size: 10000 },
        aggs: {
          read: { terms: { field: "mail.read", size: 10000 } },
          latest: { max: { field: "mail.date" } }
        }
      }
    }
  });

  const notifications = new Notifications(
    users.map((u) => [u.username, { count: 0 }])
  );

  await response.then((r) => {
    const buckets = r.aggregations?.address.buckets;
    if (!Array.isArray(buckets)) return;
    buckets?.forEach((e) => {
      const { buckets: readBuckets } = e.read;
      if (!Array.isArray(readBuckets)) return;
      const badgeCount = readBuckets.find((f) => !f.key)?.doc_count;
      if (badgeCount === undefined) return;
      const latest = new Date(e.latest.value);
      const username = addressToUsername(e.key);
      const existing = notifications.get(username) || { count: 0 };
      const newCount = badgeCount + existing.count;
      notifications.set(username, { count: newCount, latest });
    });
  });

  return notifications;
};
