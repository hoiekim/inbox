import {
  AggregationsStringTermsBucket,
  AggregationsTermsAggregateBase
} from "@elastic/elasticsearch/lib/api/types";
import { Notifications, SignedUser } from "common";
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
        aggs: { read: { terms: { field: "mail.read", size: 10000 } } }
      }
    }
  });

  const notifications = new Notifications(users.map((u) => [u.username, 0]));

  await response.then((r) => {
    const buckets = r.aggregations?.address.buckets;
    if (!Array.isArray(buckets)) return;
    buckets?.forEach((e) => {
      const { buckets } = e.read;
      if (!Array.isArray(buckets)) return;
      const badgeCount = buckets.find((f) => !f.key)?.doc_count;
      if (badgeCount === undefined) return;
      const username = addressToUsername(e.key);
      const existing = notifications.get(username) || 0;
      notifications.set(username, badgeCount + existing);
    });
  });

  return notifications;
};
