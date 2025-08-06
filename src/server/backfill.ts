import { SearchResponse } from "@elastic/elasticsearch/lib/api/types";
import { Document } from "server/lib/elasticsearch/mappings";
import "./config";
import {
  elasticsearchClient,
  FROM_ADDRESS_FIELD,
  getAccounts,
  getAccountUidNext,
  getDomainUidNext,
  getUser,
  index,
  TO_ADDRESS_FIELD
} from "server";
import { MailUid } from "common";

const pageSize = 1000;

const backfillUID = async (sent = false) => {
  let searchAfter: any[] | undefined = undefined;
  let uidCounter = 1;

  while (true) {
    type IdOnly = { _id: string };
    type SearchResult = SearchResponse<Document, IdOnly>;
    const result: SearchResult = await elasticsearchClient.search<IdOnly>({
      index,
      size: pageSize,
      sort: [{ "mail.date": "asc" }],
      _source: false,
      search_after: searchAfter,
      query: {
        bool: {
          must: [{ term: { type: "mail" } }, { term: { "mail.sent": sent } }]
        }
      }
    });

    const hits = result.hits.hits;

    if (hits.length === 0) break;

    for (const hit of hits) {
      await elasticsearchClient.update({
        index,
        id: hit._id,
        doc: { mail: { uid: { domain: uidCounter } } }
      });
      uidCounter++;
    }

    searchAfter = hits[hits.length - 1].sort;
    console.log(`Processed ${uidCounter - 1} emails...`);
  }

  console.log("Backfilling UID complete.", `sent: ${sent}`);
};

const backfillAccountUID = async (sent = false) => {
  const user = await getUser({ username: "admin" });
  const accounts = await getAccounts(user!.getSigned()!);
  const accountsArray = sent ? accounts.sent : accounts.received;
  for (const account of accountsArray) {
    const accountName = account.key;
    console.log(`Backfilling UID for account: ${accountName}`);
    let searchAfter: any[] | undefined = undefined;
    let uidCounter = 1;

    while (true) {
      type IdOnly = { _id: string };
      type SearchResult = SearchResponse<Document, IdOnly>;
      const addressField = sent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

      const result: SearchResult = await elasticsearchClient.search<IdOnly>({
        index,
        size: pageSize,
        sort: [{ "mail.date": "asc" }],
        _source: false,
        search_after: searchAfter,
        query: {
          bool: {
            must: [
              { term: { type: "mail" } },
              { term: { "mail.sent": sent } },
              { term: { [addressField]: accountName } }
            ]
          }
        }
      });

      const hits = result.hits.hits;

      if (hits.length === 0) break;

      for (const hit of hits) {
        await elasticsearchClient.update({
          index,
          id: hit._id,
          doc: { mail: { uid: { account: uidCounter } } }
        });
        uidCounter++;
      }

      searchAfter = hits[hits.length - 1].sort;
      console.log(`Processed ${uidCounter - 1} emails...`);
    }
  }

  console.log("Backfilling account UID complete.", `sent: ${sent}`);
};

const getUidNext = async (sent = false) => {
  const user = (await getUser({ username: "admin" }))!.getSigned()!;
  const accounts = await getAccounts(user);
  const receivedOrSent = sent ? accounts.sent : accounts.received;
  const account = receivedOrSent[10].key;

  const [domainUid, accountUid] = await Promise.all([
    getDomainUidNext(user, sent),
    getAccountUidNext(user, account, sent)
  ]);

  const uid = new MailUid({ domain: domainUid || 0, account: accountUid || 0 });
  console.log(`Next UID for ${account}:`, JSON.stringify(uid));
};

const main = async () => {
  //   await backfillUID().catch(console.error);
  //   await backfillAccountUID().catch(console.error);
  //   await backfillUID(true).catch(console.error);
  //   await backfillAccountUID(true).catch(console.error);
  //   await getUidNext().catch(console.error);
};

if (require.main === module) main();
