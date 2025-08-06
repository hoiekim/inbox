import { Mail, SignedUser, MailHeaderData, Pagination } from "common";
import {
  elasticsearchClient,
  index,
  getAccounts,
  getMailHeaders,
  getMailBody,
  FROM_ADDRESS_FIELD,
  TO_ADDRESS_FIELD
} from "server";
import { accountToBox, boxToAccount } from "./util";
import {
  AggregationsStringTermsBucket,
  AggregationsTermsAggregateBase
} from "@elastic/elasticsearch/lib/api/types";

// class that creates "store" object
export class Store {
  private messageCache: Map<string, MailHeaderData[]> = new Map();

  constructor(private user: SignedUser) {}

  listMailboxes = async (): Promise<string[]> => {
    try {
      const accounts = await getAccounts(this.user);
      const mailboxes = ["INBOX"];

      // Add received mail accounts as mailboxes
      accounts.received.forEach((account) => {
        if (account.key && account.key !== "INBOX") {
          const boxName = accountToBox(account.key);
          mailboxes.push(boxName);
        }
      });

      // Add sent mail accounts as mailboxes with "Sent/" prefix
      accounts.sent.forEach((account) => {
        if (account.key) {
          const boxName = accountToBox(account.key);
          mailboxes.push(`Sent/${boxName}`);
        }
      });

      return mailboxes;
    } catch (error) {
      console.error("Error listing mailboxes:", error);
      return ["INBOX"];
    }
  };

  countMessages = async (
    box: string
  ): Promise<{ total: number; unread: number } | null> => {
    try {
      const isSent = box.startsWith("Sent/");
      const accountName = boxToAccount(this.user.username, box);
      const accountField = isSent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD;

      type AddressAggregationBucket = AggregationsStringTermsBucket & {
        read?: AggregationsTermsAggregateBase<AggregationsStringTermsBucket>;
      };

      const response =
        await elasticsearchClient.search<AddressAggregationBucket>({
          index,
          size: 0,
          query: {
            bool: {
              must: [
                { term: { type: "mail" } },
                { term: { "user.id": this.user.id } },
                { term: { [accountField]: accountName } },
                { term: { "mail.sent": isSent } }
              ]
            }
          },
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
    fields: string[]
  ): Promise<Mail[]> => {
    try {
      const isSent = box.startsWith("Sent/");
      const accountName = isSent ? box.replace("Sent/", "") : box;

      const pageSize = end - start + 1;
      const page = Math.ceil(start / pageSize);

      // Get mail headers first
      const headers = await getMailHeaders(this.user, accountName, {
        sent: isSent,
        new: false,
        saved: false,
        pagination: new Pagination(page, pageSize)
      });

      // Cache the headers for this mailbox
      this.messageCache.set(box, headers);

      // Convert to Mail objects and fetch additional data if needed
      const mails: Mail[] = [];

      for (const header of headers) {
        const mail = new Mail({
          date: header.date,
          subject: header.subject,
          from: header.from,
          to: header.to,
          cc: header.cc,
          bcc: header.bcc,
          read: header.read,
          saved: header.saved,
          sent: isSent,
          messageId: header.id,
          text: "",
          html: ""
        });

        // If body content is requested, fetch it
        if (fields.includes("text") || fields.includes("html")) {
          const body = await getMailBody(this.user.id, header.id);
          if (body) {
            mail.html = body.html;
            mail.text = this.extractTextFromHtml(body.html);
            mail.attachments = body.attachments;
          }
        }

        mails.push(mail);
      }

      return mails;
    } catch (error) {
      console.error("Error getting messages:", error);
      return [];
    }
  };

  setFlags = async (
    box: string,
    i: number,
    flags: string[]
  ): Promise<boolean> => {
    try {
      const cachedMessages = this.messageCache.get(box);
      if (!cachedMessages || i >= cachedMessages.length) {
        return false;
      }

      const message = cachedMessages[i];

      const read = flags.includes("\\Seen");
      const saved = flags.includes("\\Flagged");

      if (read || saved) {
        await elasticsearchClient.update({
          index,
          id: message.id,
          doc: { mail: { read, saved } }
        });

        // Update cached message
        message.read = read;
        message.saved = saved;
      }

      return true;
    } catch (error) {
      console.error("Error setting flags:", error);
      return false;
    }
  };

  expunge = async (box: string): Promise<void> => {
    try {
      const isSent = box.startsWith("Sent/");
      const accountName = isSent ? box.replace("Sent/", "") : box;

      // Delete messages marked for deletion (in IMAP, this would be messages with \Deleted flag)
      // Since we don't have a \Deleted flag in our system, we'll skip this operation
      // In a real implementation, you might want to add a 'deleted' field to track this

      console.log(`Expunge operation completed for ${box}`);

      // Clear the cache for this mailbox
      this.messageCache.delete(box);
    } catch (error) {
      console.error("Error expunging messages:", error);
      throw error;
    }
  };

  search = async (box: string, criteria: string[]): Promise<number[]> => {
    try {
      const isSent = box.startsWith("Sent/");
      const accountName = isSent ? box.replace("Sent/", "") : box;

      // Build search query based on criteria
      const must: any[] = [
        { term: { type: "mail" } },
        { term: { "user.id": this.user.id } },
        {
          term: {
            [isSent ? FROM_ADDRESS_FIELD : TO_ADDRESS_FIELD]: accountName
          }
        },
        { term: { "mail.sent": isSent } }
      ];

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

      const response = await elasticsearchClient.search({
        index,
        size: 10000, // Reasonable limit
        query: { bool: { must } },
        sort: { "mail.date": "desc" },
        _source: false // We only need the IDs
      });

      // Return sequence numbers (1-based indexing)
      return response.hits.hits.map((_, index) => index + 1);
    } catch (error) {
      console.error("Error searching messages:", error);
      return [];
    }
  };

  private extractTextFromHtml(html: string): string {
    if (!html) return "";

    // Simple HTML to text conversion
    return html
      .replace(/<[^>]*>/g, "") // Remove HTML tags
      .replace(/&nbsp;/g, " ") // Replace &nbsp; with space
      .replace(/&amp;/g, "&") // Replace &amp; with &
      .replace(/&lt;/g, "<") // Replace &lt; with <
      .replace(/&gt;/g, ">") // Replace &gt; with >
      .replace(/&quot;/g, '"') // Replace &quot; with "
      .replace(/&#39;/g, "'") // Replace &#39; with '
      .trim();
  }
}
