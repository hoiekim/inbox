import { getRandomId, DateString } from "common";
import { AttachmentType, MailAddressType } from "./Mail";
import { Insight } from "./Insight";
import { Model } from "../Model";

export interface MailHeaderDataType {
  id: string;
  read: boolean;
  saved: boolean;
  date: DateString;
  subject: string;
  from?: MailAddressType;
  to?: MailAddressType;
  cc?: MailAddressType;
  bcc?: MailAddressType;
  insight?: Insight;
  highlight?: {
    subject?: string[];
    text?: string[];
  };
}

export class MailHeaderData
  extends Model<MailHeaderData>
  implements MailHeaderDataType
{
  declare id: string;
  declare subject: string;
  declare date: DateString;
  declare read: boolean;
  declare saved: boolean;
  declare from?: MailAddressType;
  declare to?: MailAddressType;
  declare cc?: MailAddressType;
  declare bcc?: MailAddressType;
  declare insight?: Insight;
  declare highlight?: {
    subject?: string[];
    text?: string[];
  };

  constructor(data?: Partial<MailHeaderData>) {
    super(data);
    if (!data?.id) this.id = getRandomId();
    if (!data?.subject) this.subject = "";
    if (!data?.date) this.date = new Date().toISOString();
    if (!data?.read) this.read = false;
    if (!data?.saved) this.saved = false;
  }
}

export interface MailBodyDataType {
  id: string;
  html: string;
  attachments?: AttachmentType[];
  messageId: string;
  insight?: Insight;
}

export class MailBodyData
  extends Model<MailBodyData>
  implements MailBodyDataType
{
  declare id: string;
  declare html: string;
  declare attachments?: AttachmentType[];
  declare messageId: string;
  declare insight?: Insight;

  constructor(data?: Partial<MailBodyData>) {
    super(data);
    if (!data?.id) this.id = getRandomId();
    if (!data?.html) this.html = "";
    if (!data?.messageId) this.messageId = getRandomId();
  }
}

export interface MailDataToSendType {
  sender: string;
  senderFullName: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  inReplyTo?: string;
}

export class MailDataToSend
  extends Model<MailDataToSend>
  implements MailDataToSendType
{
  declare sender: string;
  declare senderFullName: string;
  declare to: string;
  declare cc?: string;
  declare bcc?: string;
  declare subject: string;
  declare html: string;
  declare inReplyTo?: string;

  constructor(data?: Partial<MailDataToSend>) {
    super(data);
    if (!data?.sender) this.sender = "Unknown";
    if (!data?.senderFullName) this.senderFullName = "Unknown";
    if (!data?.to) this.to = "";
    if (!data?.subject) this.subject = "No Subject";
    if (!data?.html) this.html = "";
  }
}
