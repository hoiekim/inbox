import { Mail, SignedUser, MailType } from "common";
import {
  elasticsearchClient,
  index,
  getAccounts,
  FROM_ADDRESS_FIELD,
  TO_ADDRESS_FIELD,
  saveMail
} from "server";
import { accountToBox, boxToAccount } from "./util";
import {
  AggregationsStringTermsBucket,
  AggregationsTermsAggregateBase,
  QueryDslQueryContainer,
  SearchRequest as ElasticsearchSearchRequest
} from "@elastic/elasticsearch/lib/api/types";

// class that creates "store" object
export class Store {
  constructor(private user: SignedUser) {}

  /**
   * Get the user for this store
   */
  getUser(): SignedUser {
    return this.user;
  }

  listMailboxes = async (): Promise<string[]> => {
    console.log(
      `[STORE] listMailboxes for user: ${this.user.username} ${this.user.id}`
    );
    try {
      const accounts = await getAccounts(this.user);
      console.log(
        `[STORE] Found ${accounts.received.length} received, ${accounts.sent.length} sent accounts`
      );

      const mailboxes = ["INBOX"];

      // Add received mail accounts as mailboxes
      accounts.received.forEach((account) => {
        if (account.key && account.key !== "INBOX") {
          const boxName = accountToBox(account.key);
          mailboxes.push(`Received/${boxName}`);
        }
      });

      // Add sent mail accounts as mailboxes with "Sent/" prefix
      accounts.sent.forEach((account) => {
        if (account.key) {
          const boxName = accountToBox(account.key);
          mailboxes.push(`Sent/${boxName}`);
        }
      });

      console.log(`[STORE] Finally ${mailboxes.length} mailboxes`);
      return mailboxes;
    } catch (error) {
      console.error("[STORE] Error listing mailboxes:", error);
      return ["INBOX"];
    }
  };

  countMessages = async (
    box: string
  ): Promise<{ total: number; unread: number } | null> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent/");
      const accountName = boxToAccount(this.user.username, box);
      const searchFiled = isSent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

      type AddressAggregationBucket = AggregationsStringTermsBucket & {
        read?: AggregationsTermsAggregateBase<AggregationsStringTermsBucket>;
      };

      const must: QueryDslQueryContainer[] = [
        { term: { type: "mail" } },
        { term: { "user.id": this.user.id } },
        { term: { "mail.sent": isSent } }
      ];

      // For INBOX, don't filter by account - get all messages
      if (!isDomainInbox) {
        must.push({ term: { [searchFiled]: accountName } });
      }

      const response =
        await elasticsearchClient.search<AddressAggregationBucket>({
          index,
          size: 0,
          query: { bool: { must } },
          aggs: { read: { terms: { field: "mail.read", size: 10000 } } }
        });

      let total = response.hits.total ?? 0;
      if (typeof total === "object") total = total.value;

      let unread = 0;
      const readBuckets = response.aggregations?.read?.buckets;

      if (Array.isArray(readBuckets)) {
        const unread_doc_count = readBuckets.find((b) => !b.key)?.doc_count;
        if (unread_doc_count) unread = unread_doc_count;
      }

      return { total, unread };
    } catch (error) {
      console.error("Error counting messages:", error);
      return null;
    }
  };

  getMessages = async (
    box: string,
    start: number,
    end: number,
    fields: string[],
    useUid: boolean = false
  ): Promise<Map<string, Partial<Mail>>> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent/");
      const accountName = boxToAccount(this.user.username, box);
      const searchFiled = isSent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

      const must: QueryDslQueryContainer[] = [
        { term: { type: "mail" } },
        { term: { "user.id": this.user.id } },
        { term: { "mail.sent": isSent } }
      ];

      if (!isDomainInbox) {
        must.push({ term: { [searchFiled]: accountName } });
      }

      const uidField = isDomainInbox ? "mail.uid.domain" : "mail.uid.account";

      let query: ElasticsearchSearchRequest = {
        index,
        _source: [...fields, "messageId"].map((f) => `mail.${f}`),
        query: { bool: { must } },
        sort: { [uidField]: "asc" }
      };

      if (useUid) {
        // For UID-based queries, filter by UID range and get all matching
        console.log(
          `[STORE] UID query: searching ${uidField} between ${start}-${end}`
        );
        must.push({
          range: {
            [uidField]: {
              gte: start,
              lte: end === Number.MAX_SAFE_INTEGER ? 999999999 : end
            }
          }
        });
        query.size = 10000; // Large size for UID queries
      } else {
        // For sequence-based queries, use from/size (current implementation is correct)
        query.from = start - 1;
        query.size = end - start + 1;
      }

      const response = await elasticsearchClient.search(query);
      console.log(
        `[STORE] Elasticsearch returned ${response.hits.hits.length} hits for ${box}`
      );

      const mails = new Map<string, Partial<Mail>>();

      for (const hit of response.hits.hits) {
        const mailJson = hit._source?.mail as MailType;
        mails.set(hit._id!, mailJson);
      }

      return mails;
    } catch (error) {
      console.error("Error getting messages:", error);
      return new Map();
    }
  };

  setFlags = async (
    box: string,
    identifier: number,
    flags: string[],
    useUid: boolean = false
  ): Promise<boolean> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent/");
      const accountName = boxToAccount(this.user.username, box);
      const searchFiled = isSent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;
      const uidField = isDomainInbox ? "mail.uid.domain" : "mail.uid.account";

      const must: QueryDslQueryContainer[] = [
        { term: { type: "mail" } },
        { term: { "user.id": this.user.id } },
        { term: { "mail.sent": isSent } }
      ];

      if (!isDomainInbox) {
        must.push({ term: { [searchFiled]: accountName } });
      }

      let query: ElasticsearchSearchRequest;

      if (useUid) {
        must.push({ term: { [uidField]: identifier } });
        query = {
          index,
          size: 1,
          query: { bool: { must } },
          _source: false
        };
      } else {
        query = {
          index,
          from: identifier - 1,
          size: 1,
          query: { bool: { must } },
          sort: { [uidField]: "asc" },
          _source: false
        };
      }

      const response = await elasticsearchClient.search(query);

      if (response.hits.hits.length === 0) {
        return false;
      }

      const messageId = response.hits.hits[0]._id!;
      const read = flags.includes("\\Seen");
      const saved = flags.includes("\\Flagged");

      await elasticsearchClient.update({
        index,
        id: messageId,
        doc: { mail: { read, saved } }
      });

      return true;
    } catch (error) {
      console.error("Error setting flags:", error);
      return false;
    }
  };

  expunge = async (box: string): Promise<void> => {
    try {
      // Delete messages marked for deletion (in IMAP, this would be messages with \Deleted flag)
      // Since we don't have a \Deleted flag in our system, we'll skip this operation
      // In a real implementation, you might want to add a 'deleted' field to track this

      console.log(`Expunge operation completed for ${box}`);
    } catch (error) {
      console.error("Error expunging messages:", error);
      throw error;
    }
  };

  search = async (
    box: string,
    criteria: string[],
    useUid: boolean = false
  ): Promise<number[]> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent/");
      const accountName = boxToAccount(this.user.username, box);
      const searchFiled = isSent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

      // Build search query based on criteria
      const must: QueryDslQueryContainer[] = [
        { term: { type: "mail" } },
        { term: { "user.id": this.user.id } },
        { term: { "mail.sent": isSent } }
      ];

      if (!isDomainInbox) {
        must.push({ term: { [searchFiled]: accountName } });
      }

      // Parse IMAP search criteria
      for (let i = 0; i < criteria.length; i++) {
        const criterion = criteria[i].toUpperCase();

        switch (criterion) {
          case "UNSEEN":
            must.push({ term: { "mail.read": false } });
            break;
          case "SEEN":
            must.push({ term: { "mail.read": true } });
            break;
          case "FLAGGED":
            must.push({ term: { "mail.saved": true } });
            break;
          case "UNFLAGGED":
            must.push({ term: { "mail.saved": false } });
            break;
          case "SUBJECT":
            if (i + 1 < criteria.length) {
              const subject = criteria[++i];
              must.push({
                wildcard: {
                  "mail.subject": `*${subject}*`
                }
              });
            }
            break;
          case "FROM":
            if (i + 1 < criteria.length) {
              const from = criteria[++i];
              must.push({
                wildcard: {
                  "mail.from.text": `*${from}*`
                }
              });
            }
            break;
          case "TO":
            if (i + 1 < criteria.length) {
              const to = criteria[++i];
              must.push({
                wildcard: {
                  "mail.to.text": `*${to}*`
                }
              });
            }
            break;
        }
      }

      const uidField = isDomainInbox ? "mail.uid.domain" : "mail.uid.account";

      const response = await elasticsearchClient.search({
        index,
        size: 10000, // Reasonable limit
        query: { bool: { must } },
        sort: { [uidField]: "asc" },
        _source: [uidField] // Only need UID field for search results
      });

      if (useUid) {
        // Return UIDs directly
        return response.hits.hits
          .map((hit) => {
            const mailJson = hit._source?.mail as MailType;
            return isDomainInbox
              ? mailJson.uid?.domain || 0
              : mailJson.uid?.account || 0;
          })
          .filter((uid) => uid > 0);
      } else {
        // Return sequence numbers (1-based indexing)
        return response.hits.hits.map((_, index) => index + 1);
      }
    } catch (error) {
      console.error("Error searching messages:", error);
      return [];
    }
  };

  /**
   * Store a new mail message using the existing saveMail function
   */
  storeMail = async (mail: Mail): Promise<boolean> => {
    try {
      const result = await saveMail(this.user.id, mail);
      return !!result; // Convert to boolean
    } catch (error) {
      console.error("Error storing mail:", error);
      return false;
    }
  };
}
