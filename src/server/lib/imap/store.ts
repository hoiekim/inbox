/* eslint-disable no-case-declarations */
import {
  Mail,
  SignedUser,
  MailAddressValueType,
  AttachmentType,
  Insight,
} from "common";
import {
  getAccountStats,
  countMessages,
  getMailsByRange,
  setMailFlags,
  searchMailsByUid,
  saveMail as pgSaveMail,
  expungeDeletedMails,
  expungeMailsByUid,
  getAllUids as pgGetAllUids,
  getFirstUnseenUid as pgGetFirstUnseenUid,
  getHighestModseq as pgGetHighestModseq,
  SaveMailInput,
  UpdatedMailFlags,
  StoreOperationType,
} from "../postgres/repositories/mails";
import { getMailboxesByUser } from "../postgres/repositories/mailboxes";
import {
  accountToBox,
  accountToSentBox,
  boxToAccount,
  isDomainScoped,
  isInbox,
  isSentBox,
  isAccountsFolder,
  isSentMessagesAccountsFolder,
  ACCOUNTS_FOLDER,
  SENT_MESSAGES_FOLDER,
  SENT_MESSAGES_ACCOUNTS_FOLDER,
} from "./util";
import {
  SearchCriterion,
  UidCriterion,
} from "./types";
import { logger, getUserDomain } from "server";

type SimplifiedCriterion = { type: string; value?: unknown };

/**
 * A `Partial<Mail>` extended with the four synthetic streaming fields the
 * IMAP BODY[] / RFC822 path opts into (`text_octets` / `html_octets` +
 * `mail_id` / `user_id`). When all four are set and `text` / `html` are
 * absent, `buildMessageSegments` emits `lazy-text` segments — the body is
 * streamed from Postgres via chunked SUBSTRING reads rather than loaded as
 * a string. Existing consumers that never request the octet fields see the
 * same shape as `Partial<Mail>`.
 */
export type StoreFetchedMail = Partial<Mail> & {
  text_octets?: number;
  html_octets?: number;
  mail_id?: string;
  user_id?: string;
};

/**
 * Normalises a parsed SearchCriterion into the flat `{ type, value }` shape that
 * searchMailsByUid consumes. NOT/OR recurse so their operands are normalised too —
 * otherwise the SQL builder would read the wrong field off the raw parser shape
 * (e.g. `.date`/`.field` instead of `.value`) and silently mis-handle the nested
 * criterion. An unexpressible leaf is preserved as a bare `{ type }` (never
 * dropped) so buildCriterionClause maps it to a match-none fragment — the SEARCH
 * fails closed, never matching every message (#672). A UID set
 * normalises to one `UID_SET` entry carrying all its ranges, so the SQL builder
 * ORs the ranges among themselves (a message is in the set if it falls in ANY
 * range) — nested UID keys under NOT/OR resolve the same way. See #551, #659.
 */
export const simplifyCriterion = (
  criterion: SearchCriterion
): SimplifiedCriterion | null => {
  const type = criterion.type.toUpperCase();
  switch (type) {
    // Flag-based: no additional value
    case "ALL":
    case "UNSEEN":
    case "SEEN":
    case "ANSWERED":
    case "UNANSWERED":
    case "DELETED":
    case "UNDELETED":
    case "FLAGGED":
    case "UNFLAGGED":
    case "DRAFT":
    case "UNDRAFT":
    case "NEW":
    case "OLD":
    case "RECENT":
      return { type };

    // Text search: value is embedded in the criterion object
    case "SUBJECT":
    case "FROM":
    case "TO":
    case "CC":
    case "BCC":
    case "BODY":
    case "TEXT": {
      const textCriterion = criterion as { type: string; value: string };
      return { type, value: textCriterion.value };
    }

    // Header search
    case "HEADER": {
      const hdr = criterion as { type: string; field: string; value: string };
      return { type, value: { field: hdr.field, text: hdr.value } };
    }

    // Date criteria: value is a Date object
    case "BEFORE":
    case "ON":
    case "SINCE":
    case "SENTBEFORE":
    case "SENTON":
    case "SENTSINCE": {
      const dateCriterion = criterion as { type: string; date: Date };
      return { type, value: dateCriterion.date };
    }

    // Size criteria
    case "LARGER":
    case "SMALLER": {
      const sizeCriterion = criterion as { type: string; size: number };
      return { type, value: sizeCriterion.size };
    }

    // Logical NOT: negate a single (normalised) criterion. `inner` is never
    // null in practice — no leaf returns null post-#672 (unexpressible leaves
    // fail closed via the default case), so the null-guard here is defensively
    // unreachable. If a null-returning leaf is ever reintroduced, route it
    // through buildCriterionClause's match-none algebra rather than dropping
    // the node — a dropped NOT fails OPEN (matches everything).
    case "NOT": {
      const notCriterion = criterion as { type: string; criterion: SearchCriterion };
      const inner = simplifyCriterion(notCriterion.criterion);
      return inner ? { type: "NOT", value: inner } : null;
    }

    // Logical OR: two (normalised) criteria
    case "OR": {
      const orCriterion = criterion as {
        type: string;
        left: SearchCriterion;
        right: SearchCriterion;
      };
      const left = simplifyCriterion(orCriterion.left);
      const right = simplifyCriterion(orCriterion.right);
      if (left && right) return { type: "OR", value: { left, right } };
      // Defensively unreachable: neither side is null because no leaf returns
      // null post-#672. Were a side ever null, dropping the OR fails OPEN
      // (matches everything) — the opposite of the fail-closed direction the
      // rest of the search path now takes. A reintroduced null-leaf should
      // preserve the OR node and let buildCriterionClause reduce it instead.
      return null;
    }

    // Custom keyword flags. The server stores only the system flag set
    // (\Seen \Flagged \Deleted \Draft \Answered) and no custom keywords, so
    // KEYWORD can never match and UNKEYWORD always matches — the flag value is
    // irrelevant. Preserve the type (no value) and let buildCriterionClause map
    // KEYWORD to match-none and UNKEYWORD to match-all.
    case "KEYWORD":
    case "UNKEYWORD":
      return { type };

    // UID set: carry every range in one entry so the SQL builder ORs them —
    // set membership means a message matches if it falls in ANY range (#659).
    case "UID": {
      const uidCriterion = criterion as UidCriterion;
      return { type: "UID_SET", value: uidCriterion.sequenceSet.ranges };
    }

    // Unsupported criterion: preserve the type (no value) rather than dropping
    // it here. Dropping would leave it out of the WHERE clause entirely, which
    // matches EVERY message (fail-open) — the dangerous direction for a filter.
    // buildCriterionClause maps any type it can't express to a match-none
    // fragment, so the criterion fails closed instead. (#672)
    default:
      logger.warn("Unsupported search criterion", { component: "imap.store", type });
      return { type };
  }
};

// class that creates "store" object
export class Store {
  constructor(private user: SignedUser) {}

  /**
   * Get the user for this store
   */
  getUser(): SignedUser {
    return this.user;
  }

  /**
   * Resolve an IMAP mailbox name into the (accountName, isSent) pair used by
   * the mail repository. `INBOX` and the unified `Sent Messages` folder both
   * map to `accountName=null` (no account scoping); everything else maps to
   * the per-account address derived from the box name.
   */
  private resolveBox(box: string): { accountName: string | null; isSent: boolean } {
    const isDomainInbox = isInbox(box);
    const isUnifiedSent = box === SENT_MESSAGES_FOLDER;
    const isSent = isSentBox(box);
    const accountName =
      isDomainInbox || isUnifiedSent ? null : boxToAccount(this.user.username, box);
    return { accountName, isSent };
  }

  /**
   * Variant of `resolveBox` for the eight #702 mapping-aware read/write sites
   * (countMessages/getMailsByRange/setMailFlags/getAllUids/getFirstUnseenUid/
   * searchMailsByUid/expungeDeletedMails/expungeMailsByUid). `mailboxArg` is
   * the raw box path — the same string the write side stores in
   * `mail_mailbox_uid.mailbox` — for account-scoped, sent-account-scoped, AND
   * user-created mailboxes (`Archive`, etc.). `null` for the two domain-scoped
   * views (`INBOX`, unified `Sent Messages`), which stay on `mails.uid_domain`.
   */
  private resolveMappedBox(box: string): { mailboxArg: string | null; isSent: boolean } {
    const isSent = isSentBox(box);
    const mailboxArg = isDomainScoped(box) ? null : box;
    return { mailboxArg, isSent };
  }

  /**
   * Build the listable mailbox set; propagate backend errors. `listMailboxes`
   * (below) wraps this in a fallback so the LIST command stays resilient,
   * but the existence gate (`mailboxExists`) needs to distinguish "the user
   * doesn't have this mailbox" from "I couldn't determine whether they do" —
   * conflating the two turns a transient DB hiccup into a permanent-sounding
   * `NO Mailbox does not exist` for the SELECT/STATUS/EXAMINE caller (#601).
   */
  private listMailboxesOrThrow = async (): Promise<string[]> => {
    // Match HTTP /api/mails/accounts: filter by user's domain so we only
    // expose addresses that belong to this server, not every external
    // CC/BCC/recipient address found on stored mails.
    const userDomain = getUserDomain(this.user.username);
    const [receivedStats, sentStats, userMailboxes] = await Promise.all([
      getAccountStats(this.user.id, false, userDomain),
      getAccountStats(this.user.id, true, userDomain),
      getMailboxesByUser(this.user.id),
    ]);

    const seen = new Set<string>();
    const addMailbox = (name: string) => {
      const trimmed = name.trim();
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        mailboxes.push(trimmed);
      }
    };

    const mailboxes: string[] = [];
    addMailbox("INBOX");

    // Add Sent Messages (unified across all accounts) if any sent mail exists
    if (sentStats.length > 0) {
      addMailbox(SENT_MESSAGES_FOLDER);
    }

    // Add accounts/ parent folder if any received-mail accounts exist
    if (receivedStats.length > 0) {
      addMailbox(ACCOUNTS_FOLDER);
    }

    // Add received mail accounts under accounts/ (deduplicated)
    receivedStats.forEach((stat) => {
      if (stat.address) {
        addMailbox(accountToBox(stat.address));
      }
    });

    // Add Sent Messages/accounts/ parent folder if any per-account sent mail exists
    if (sentStats.length > 0) {
      addMailbox(SENT_MESSAGES_ACCOUNTS_FOLDER);
    }

    // Add per-account sent mailboxes under Sent Messages/accounts/ (deduplicated)
    sentStats.forEach((stat) => {
      if (stat.address) {
        addMailbox(accountToSentBox(stat.address));
      }
    });

    // Add user-created mailboxes (those without a special_use and no address tie-in)
    const systemNames = new Set(mailboxes.map((m) => m.toLowerCase()));
    userMailboxes
      .filter((mb) => mb.special_use === null && mb.address === null)
      .forEach((mb) => {
        if (!systemNames.has(mb.name.toLowerCase())) {
          mailboxes.push(mb.name);
        }
      });

    return mailboxes;
  };

  /**
   * LIST-facing version: on backend error, log + return a single `["INBOX"]`
   * fallback so the LIST command can still respond. The fallback is fine for
   * LIST (the client just sees a minimal view) but NOT fine for the existence
   * gate — see `mailboxExists` below.
   */
  listMailboxes = async (): Promise<string[]> => {
    try {
      return await this.listMailboxesOrThrow();
    } catch (error) {
      logger.error("Error listing mailboxes", { component: "imap.store" }, error);
      return ["INBOX"];
    }
  };

  /**
   * Whether `box` names a mailbox that actually exists for this user. INBOX
   * always exists; every other name must be a member of the listable set
   * (the unified Sent folder, the accounts/ parents, per-account boxes, and
   * user-created mailboxes). countMessages can't answer this — it returns a
   * zero-count aggregate for any unknown name — so SELECT/EXAMINE/STATUS must
   * gate on this to return a tagged NO for phantom mailboxes rather than
   * reporting them as valid-but-empty (RFC 3501 §6.3.1/2/10). See #595.
   *
   * Uses `listMailboxesOrThrow` (not the fallback `listMailboxes`) so a
   * transient DB error propagates: the SELECT/STATUS handler's existing
   * try-catch then writes `NO SELECT failed` / `NO STATUS failed` (a
   * retry-friendly transient signal) instead of `NO Mailbox does not exist`
   * (a permanent signal that makes the client treat the mailbox as deleted).
   * See #601.
   */
  mailboxExists = async (box: string): Promise<boolean> => {
    if (isInbox(box)) return true;
    const mailboxes = await this.listMailboxesOrThrow();
    return mailboxes.includes(box);
  };

  countMessages = async (
    box: string
  ): Promise<{ total: number; unread: number; maxUid: number } | null> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await countMessages(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error counting messages", { component: "imap.store", box }, error);
      return null;
    }
  };

  /**
   * Get all UIDs in a mailbox, ordered by UID ascending.
   * Used for building sequence number mapping.
   */
  getAllUids = async (box: string): Promise<number[]> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await pgGetAllUids(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error getting all UIDs", { component: "imap.store", box }, error);
      return [];
    }
  };

  /**
   * UID of the first (lowest-UID) unseen message in a mailbox, or null when
   * everything is read. Used to derive the `[UNSEEN <seq>]` SELECT response.
   */
  getFirstUnseenUid = async (box: string): Promise<number | null> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await pgGetFirstUnseenUid(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error getting first unseen UID", { component: "imap.store", box }, error);
      return null;
    }
  };

  /**
   * HIGHESTMODSEQ for a mailbox (RFC 4551 §3.1.1) — the largest mod-sequence of
   * any message routed to it. Backs the `* OK [HIGHESTMODSEQ N]` SELECT/EXAMINE
   * response code and the STATUS HIGHESTMODSEQ item. Falls back to 1 (the
   * DEFAULT-1 floor, never 0) on error so a transient DB hiccup doesn't signal
   * "no persistent mod-sequences".
   */
  getHighestModseq = async (box: string): Promise<number> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await pgGetHighestModseq(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error getting highest modseq", { component: "imap.store", box }, error);
      return 1;
    }
  };

  getMessages = async (
    box: string,
    start: number,
    end: number,
    fields: string[],
    useUid: boolean = false
  ): Promise<Map<string, StoreFetchedMail>> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      const mailModels = await getMailsByRange(
        this.user.id,
        mailboxArg,
        isSent,
        start,
        end,
        useUid,
        fields.flatMap((f) => this.mapFieldName(f))
      );

      const mails = new Map<string, StoreFetchedMail>();

      for (const [id, model] of mailModels) {
        const mail: StoreFetchedMail = {
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
          answered: model.answered,
        };
        // Streaming-body handoff (BODY[] / RFC822 path). When
        // `getRequestedFields` opted into the pg SUBSTRING stream, these
        // four fields carry the identity + pre-measured octet counts the
        // segment builder needs to emit `lazy-text` segments instead of
        // loading the multi-MB text/html columns. Only-set-if-defined so
        // existing consumers (bare-FLAGS fetches etc.) that never
        // requested them see the same shape as before.
        if (model.text_octets !== undefined) mail.text_octets = model.text_octets;
        if (model.html_octets !== undefined) mail.html_octets = model.html_octets;
        if (model.mail_id !== undefined) mail.mail_id = model.mail_id;
        if (model.user_id !== undefined) mail.user_id = model.user_id;
        if (model.uid_domain !== undefined) {
          mail.uid = {
            domain: model.uid_domain,
            // Per-mailbox UID lives in mail_mailbox_uid.uid, aliased as
            // `uid_mailbox` by getMailsByRange's JOIN for account-scoped
            // and user-created mailboxes. Domain-scoped views (INBOX,
            // unified Sent Messages) don't populate it — 0 signals "use
            // uid.domain instead", matching the domain-only wire path.
            account: model.uid_mailbox ?? 0,
          };
        }
        if (model.modseq !== undefined) {
          mail.modseq = model.modseq;
        }
        // rfc822_size: cached BODY[] byte count. `null` on the DB row means
        // "not computed yet"; `undefined` on the model means "not
        // requested" (getRequestedFields didn't add it, e.g. FLAGS-only
        // fetch). Preserve both — the RFC822.SIZE fetch handler
        // distinguishes stored-value hit (typeof === 'number') from
        // fall-through (compute + persist).
        if (model.rfc822_size !== undefined) {
          mail.rfc822_size = model.rfc822_size;
        }
        // text_line_count / html_line_count: cached BODYSTRUCTURE `lines`
        // fields. Same preserve-null-vs-undefined dance as rfc822_size —
        // the BODYSTRUCTURE fetch handler distinguishes stored-value hit
        // (typeof === 'number') from cache-miss fallback (load text/html
        // + compute + persist).
        if (model.text_line_count !== undefined) {
          mail.text_line_count = model.text_line_count;
        }
        if (model.html_line_count !== undefined) {
          mail.html_line_count = model.html_line_count;
        }

        if (model.from_address) {
          mail.from = {
            value: model.from_address as MailAddressValueType[],
            text: model.from_text || "",
          };
        }
        if (model.to_address) {
          mail.to = {
            value: model.to_address as MailAddressValueType[],
            text: model.to_text || "",
          };
        }
        if (model.cc_address) {
          mail.cc = {
            value: model.cc_address as MailAddressValueType[],
            text: model.cc_text || "",
          };
        }
        if (model.bcc_address) {
          mail.bcc = {
            value: model.bcc_address as MailAddressValueType[],
            text: model.bcc_text || "",
          };
        }
        if (model.reply_to_address) {
          mail.replyTo = {
            value: model.reply_to_address as MailAddressValueType[],
            text: model.reply_to_text || "",
          };
        }
        if (model.envelope_from) {
          mail.envelopeFrom = model.envelope_from as MailAddressValueType[];
        }
        if (model.envelope_to) {
          mail.envelopeTo = model.envelope_to as MailAddressValueType[];
        }
        if (model.attachments) {
          mail.attachments = model.attachments as AttachmentType[];
        }
        if (model.insight) {
          mail.insight = model.insight as Insight;
        }

        mails.set(id, mail);
      }

      return mails;
    } catch (error) {
      logger.error("Error getting messages", { component: "imap.store", box }, error);
      return new Map();
    }
  };

  private mapFieldName(field: string): string[] {
    const fieldMap: Record<string, string[]> = {
      messageId: ["message_id"],
      uid: ["uid_domain", "uid_mailbox"],
      from: ["from_address", "from_text"],
      to: ["to_address", "to_text"],
      cc: ["cc_address", "cc_text"],
      bcc: ["bcc_address", "bcc_text"],
      replyTo: ["reply_to_address", "reply_to_text"],
    };
    return fieldMap[field] || [field];
  }

  setFlags = async (
    box: string,
    start: number,
    end: number,
    flags: string[],
    useUid: boolean = false,
    operation: StoreOperationType = "FLAGS"
  ): Promise<UpdatedMailFlags[]> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await setMailFlags(
        this.user.id,
        mailboxArg,
        isSent,
        start,
        end,
        flags,
        useUid,
        operation
      );
    } catch (error) {
      logger.error("Error setting flags", { component: "imap.store", box, flags }, error);
      return [];
    }
  };

  /**
   * Permanently delete messages marked with \Deleted flag
   * Returns the UIDs of deleted messages
   */
  expunge = async (box: string): Promise<number[]> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await expungeDeletedMails(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error expunging messages", { component: "imap.store", box }, error);
      throw error;
    }
  };

  /**
   * Soft-delete a specific set of UIDs in `box` without touching their
   * `\Deleted` flag. Used by RFC 6851 MOVE (§3.3 forbids the
   * COPY+STORE(\Deleted)+EXPUNGE pattern, since EXPUNGE is mailbox-wide
   * and would also remove pre-existing \Deleted-flagged messages).
   * Propagates errors so the MOVE handler can write `NO MOVE failed`
   * instead of falsely emitting OK + COPYUID against a no-op.
   */
  expungeUids = async (box: string, uids: number[]): Promise<number[]> => {
    if (uids.length === 0) return [];
    const { mailboxArg, isSent } = this.resolveMappedBox(box);
    return await expungeMailsByUid(this.user.id, mailboxArg, isSent, uids);
  };

  search = async (
    box: string,
    criteria: SearchCriterion[]
  ): Promise<number[]> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);

      // Convert criteria to a simpler flat format for searchMailsByUid. Every
      // criterion — UID sets (one UID_SET entry per set), flags, text, dates,
      // and nested NOT/OR operands — normalises through simplifyCriterion.
      const simplifiedCriteria: SimplifiedCriterion[] = [];

      for (const criterion of criteria) {
        const simplified = simplifyCriterion(criterion);
        if (simplified) simplifiedCriteria.push(simplified);
      }

      return await searchMailsByUid(
        this.user.id,
        mailboxArg,
        isSent,
        simplifiedCriteria
      );
    } catch (error) {
      logger.error("Error searching messages", { component: "imap.store", box }, error);
      return [];
    }
  };

  /**
   * Store a new mail message. `mailbox` is the destination path
   * (`COPY dest`, `MOVE dest`, `APPEND target`) — passed through to
   * `pgSaveMail` for the account-scoped `mail_mailbox_uid` mapping.
   * Caller passes `undefined` for domain-scoped destinations (INBOX,
   * unified `Sent Messages`) so the mapping only records account-space
   * UIDs. Undefined here + `pgSaveMail`'s guard skips the mapping write.
   */
  storeMail = async (mail: Mail, mailbox?: string): Promise<boolean> => {
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
        answered: mail.answered,
        insight: mail.insight,
        uid_domain: mail.uid?.domain,
        uid_mailbox: mail.uid?.account,
        mailbox,
      };

      const result = await pgSaveMail(input);
      if (!result) return false;
      // Reconcile mail.uid.{account,domain} to the PERSISTED UIDs. On
      // a 23505 merge (partial-failure retry of a multi-mail COPY /
      // MOVE / APPEND, or an intentional dup-op to the same dest),
      // saveMail returns the FIRST-attempt row's UIDs — the retry's
      // freshly-reserved values would advertise UIDs that don't exist
      // (client `UID FETCH`es come back empty). Wire callers (COPY /
      // MOVE / APPEND) push mail.uid.{domain|account} into COPYUID /
      // APPENDUID; reconciling here means no caller-side change. See
      // #721 / #722.
      if (mail.uid) {
        if (result.uid_mailbox !== undefined) mail.uid.account = result.uid_mailbox;
        if (result.uid_domain !== undefined) mail.uid.domain = result.uid_domain;
      }
      return true;
    } catch (error) {
      logger.error("Error storing mail", { component: "imap.store" }, error);
      return false;
    }
  };
}
