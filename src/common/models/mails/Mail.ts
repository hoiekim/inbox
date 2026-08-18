import { DateString, getRandomId } from "common";
import { Insight } from "./Insight";
import { Model } from "../Model";

export interface MailAddressValueType {
  address?: string;
  name?: string;
}

export class MailAddressValue
  extends Model<MailAddressValue>
  implements MailAddressValueType
{
  declare address?: string;
  declare name?: string;
}

export interface MailAddressType {
  value: MailAddressValueType[];
  text: string;
}

export class MailAddress extends Model<MailAddress> implements MailAddressType {
  declare value: MailAddressValue[];
  declare text: string;

  constructor(data?: Partial<MailAddress>) {
    super(data);
    if (!data?.value) this.value = [];
    if (!data?.text) this.text = "";
  }
}

export interface AttachmentType {
  content: { data: string };
  contentType: string;
  filename: string;
  size: number;
}

export class Attachment extends Model<Attachment> implements AttachmentType {
  declare content: { data: string };
  declare contentType: string;
  declare filename: string;
  declare size: number;

  constructor(data?: Partial<Attachment>) {
    super(data);
    if (!data?.content) this.content = { data: "" };
    if (!data?.contentType) this.contentType = "text/plain";
    if (!data?.filename) this.filename = "unnamed_file";
    if (!data?.size) this.size = 0;
  }
}

export interface MailUidType {
  domain: number;
  account: number;
}

export class MailUid extends Model<MailUid> implements MailUidType {
  declare domain: number;
  declare account: number;

  constructor(data?: Partial<MailUid>) {
    super(data);
    if (!data?.domain) this.domain = 0;
    if (!data?.account) this.account = 0;
  }
}

export interface MailType {
  attachments?: AttachmentType[];
  from?: MailAddressType;
  to?: MailAddressType;
  cc?: MailAddressType;
  bcc?: MailAddressType;
  replyTo?: MailAddressType;
  envelopeFrom?: MailAddressValueType[];
  envelopeTo: MailAddressValueType[];
  date: DateString;
  html: string;
  text: string;
  subject: string;
  messageId: string;
  read: boolean;
  saved: boolean;
  sent: boolean;
  deleted: boolean;
  draft: boolean;
  answered: boolean;
  insight?: Insight;
  uid: MailUidType;
  /**
   * IMAP CONDSTORE mod-sequence (RFC 4551) — the per-message change counter,
   * sibling to `uid`. Server-populated for IMAP FETCH MODSEQ / HIGHESTMODSEQ;
   * the HTTP client never reads it, hence optional.
   */
  modseq?: number;
  /**
   * Cached byte count of the serialized RFC 822 form (i.e. what BODY[] /
   * RFC822 returns). Server-populated lazily on the first FETCH that
   * derives it (see fetch-helpers RFC822.SIZE / RFC822 cases). Optional
   * because the DB column starts NULL for existing rows and gets
   * populated on their first observation; the HTTP client never reads it.
   */
  rfc822_size?: number | null;
  /**
   * Cached line counts for the mail's `text` / `html` columns, matching
   * the RFC 3501 §7.4.2 BODYSTRUCTURE `lines` field. Populated at INSERT
   * time from the incoming strings and lazily backfilled for pre-existing
   * rows on the first BODYSTRUCTURE fetch. Optional because the DB
   * columns start NULL for pre-migration rows; the HTTP client never
   * reads either.
   */
  text_line_count?: number | null;
  html_line_count?: number | null;
}

export class Mail extends Model<Mail> implements MailType {
  declare attachments?: AttachmentType[];
  declare from?: MailAddressType;
  declare to?: MailAddressType;
  declare cc?: MailAddressType;
  declare bcc?: MailAddressType;
  declare replyTo?: MailAddressType;
  declare envelopeFrom?: MailAddressValueType[];
  declare envelopeTo: MailAddressValueType[];
  declare date: DateString;
  declare html: string;
  declare text: string;
  declare subject: string;
  declare messageId: string;
  declare read: boolean;
  declare saved: boolean;
  declare sent: boolean;
  declare deleted: boolean;
  declare draft: boolean;
  declare answered: boolean;
  declare insight?: Insight;
  declare uid: MailUidType;
  declare modseq?: number;
  declare rfc822_size?: number | null;
  declare text_line_count?: number | null;
  declare html_line_count?: number | null;

  constructor(data?: Partial<Mail>) {
    super(data);
    if (!data?.envelopeTo) this.envelopeTo = [];
    if (!data?.attachments) this.attachments = [];
    if (!data?.date) this.date = new Date().toISOString();
    if (!data?.html) this.html = "";
    if (!data?.text) this.text = "";
    if (!data?.subject) this.subject = "";
    if (!data?.messageId) this.messageId = getRandomId();
    if (!data?.read) this.read = false;
    if (!data?.saved) this.saved = false;
    if (!data?.sent) this.sent = false;
    if (!data?.deleted) this.deleted = false;
    if (!data?.draft) this.draft = false;
    if (!data?.answered) this.answered = false;
    if (!data?.uid) this.uid = new MailUid();
  }
}
