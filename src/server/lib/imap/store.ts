import { Mail, SignedUser, MailType } from "common";
import {
  getAccountStats,
  countMessages,
  getMailsByRange,
  setMailFlags,
  searchMailsByUid,
  saveMail as pgSaveMail,
  expungeDeletedMails,
  SaveMailInput,
} from "../postgres/repositories/mails";
import { accountToBox, boxToAccount } from "./util";
import { SearchCriterion, UidCriterion } from "./types";

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
    try {
      const [receivedStats, sentStats] = await Promise.all([
        getAccountStats(this.user.id, false),
        getAccountStats(this.user.id, true),
      ]);

      const mailboxes = ["INBOX"];

      // Add received mail accounts as mailboxes
      receivedStats.forEach((stat) => {
        if (stat.address && stat.address !== "INBOX") {
          const boxName = accountToBox(stat.address);
          mailboxes.push(`INBOX/${boxName}`);
        }
      });

      // Add sent mail accounts as mailboxes with "Sent Messages/" prefix
      sentStats.forEach((stat) => {
        if (stat.address) {
          const boxName = accountToBox(stat.address);
          mailboxes.push(`Sent Messages/${boxName}`);
        }
      });

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
      const isSent = box.startsWith("Sent Messages/");
      const accountName = isDomainInbox
        ? null
        : boxToAccount(this.user.username, box);

      return await countMessages(this.user.id, accountName, isSent);
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
      const isSent = box.startsWith("Sent Messages/");
      const accountName = isDomainInbox
        ? null
        : boxToAccount(this.user.username, box);

      const mailModels = await getMailsByRange(
        this.user.id,
        accountName,
        isSent,
        start,
        end,
        useUid,
        fields.map((f) => this.mapFieldName(f))
      );

      const mails = new Map<string, Partial<Mail>>();

      for (const [id, model] of mailModels) {
        const mail: Partial<Mail> = {
          messageId: model.message_id,
          subject: model.subject,
          date: model.date,
          html: model.html,
          text: model.text,
          read: model.read,
          saved: model.saved,
          sent: model.sent,
          deleted: model.deleted,
          draft: model.draft,
          uid: {
            domain: model.uid_domain,
            account: model.uid_account,
          },
        };

        if (model.from_address) {
          mail.from = {
            value: model.from_address as any,
            text: model.from_text || "",
          };
        }
        if (model.to_address) {
          mail.to = {
            value: model.to_address as any,
            text: model.to_text || "",
          };
        }
        if (model.cc_address) {
          mail.cc = {
            value: model.cc_address as any,
            text: model.cc_text || "",
          };
        }
        if (model.bcc_address) {
          mail.bcc = {
            value: model.bcc_address as any,
            text: model.bcc_text || "",
          };
        }
        if (model.envelope_from) {
          mail.envelopeFrom = model.envelope_from as any;
        }
        if (model.envelope_to) {
          mail.envelopeTo = model.envelope_to as any;
        }
        if (model.attachments) {
          mail.attachments = model.attachments as any;
        }
        if (model.insight) {
          mail.insight = model.insight as any;
        }

        mails.set(id, mail);
      }

      return mails;
    } catch (error) {
      console.error("Error getting messages:", error);
      return new Map();
    }
  };

  private mapFieldName(field: string): string {
    const fieldMap: Record<string, string> = {
      messageId: "message_id",
      uid: "uid_domain, uid_account",
    };
    return fieldMap[field] || field;
  }

  setFlags = async (
    box: string,
    start: number,
    end: number,
    flags: string[],
    useUid: boolean = false
  ): Promise<boolean> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent Messages/");
      const accountName = isDomainInbox
        ? null
        : boxToAccount(this.user.username, box);

      return await setMailFlags(
        this.user.id,
        accountName,
        isSent,
        start,
        end,
        flags,
        useUid
      );
    } catch (error) {
      console.error("Error setting flags:", error);
      return false;
    }
  };

  /**
   * Permanently delete messages marked with \Deleted flag
   * Returns the UIDs of deleted messages
   */
  expunge = async (box: string): Promise<number[]> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent Messages/");
      const accountName = isDomainInbox
        ? null
        : boxToAccount(this.user.username, box);

      return await expungeDeletedMails(this.user.id, accountName, isSent);
    } catch (error) {
      console.error("Error expunging messages:", error);
      throw error;
    }
  };

  search = async (
    box: string,
    criteria: SearchCriterion[]
  ): Promise<number[]> => {
    try {
      const isDomainInbox = box === "INBOX";
      const isSent = box.startsWith("Sent Messages/");
      const accountName = isDomainInbox
        ? null
        : boxToAccount(this.user.username, box);

      // Convert criteria to a simpler format
      const simplifiedCriteria: { type: string; value?: unknown }[] = [];

      for (let i = 0; i < criteria.length; i++) {
        const criterion = criteria[i];
        const type = criterion.type.toUpperCase();

        switch (type) {
          case "UNSEEN":
          case "SEEN":
          case "FLAGGED":
          case "UNFLAGGED":
            simplifiedCriteria.push({ type });
            break;
          case "SUBJECT":
          case "FROM":
          case "TO":
            if (i + 1 < criteria.length) {
              simplifiedCriteria.push({ type, value: criteria[++i] });
            }
            break;
          case "UID":
            // Handle UID ranges
            const uidCriterion = criterion as UidCriterion;
            for (const range of uidCriterion.sequenceSet.ranges) {
              if (range.end === undefined) {
                simplifiedCriteria.push({
                  type: "UID_EXACT",
                  value: range.start,
                });
              } else {
                simplifiedCriteria.push({
                  type: "UID_RANGE",
                  value: { start: range.start, end: range.end },
                });
              }
            }
            break;
          default:
            console.warn(`Unsupported search criterion: ${type}`);
        }
      }

      return await searchMailsByUid(
        this.user.id,
        accountName,
        isSent,
        simplifiedCriteria
      );
    } catch (error) {
      console.error("Error searching messages:", error);
      return [];
    }
  };

  /**
   * Store a new mail message
   */
  storeMail = async (mail: Mail): Promise<boolean> => {
    try {
      const input: SaveMailInput = {
        user_id: this.user.id,
        message_id: mail.messageId,
        subject: mail.subject,
        date: mail.date,
        html: mail.html,
        text: mail.text,
        from_address: mail.from?.value,
        from_text: mail.from?.text,
        to_address: mail.to?.value,
        to_text: mail.to?.text,
        cc_address: mail.cc?.value,
        cc_text: mail.cc?.text,
        bcc_address: mail.bcc?.value,
        bcc_text: mail.bcc?.text,
        reply_to_address: mail.replyTo?.value,
        reply_to_text: mail.replyTo?.text,
        envelope_from: mail.envelopeFrom,
        envelope_to: mail.envelopeTo,
        attachments: mail.attachments,
        read: mail.read,
        saved: mail.saved,
        sent: mail.sent,
        deleted: mail.deleted,
        draft: mail.draft,
        insight: mail.insight,
        uid_domain: mail.uid?.domain,
        uid_account: mail.uid?.account,
      };

      const result = await pgSaveMail(input);
      return !!result;
    } catch (error) {
      console.error("Error storing mail:", error);
      return false;
    }
  };
}
