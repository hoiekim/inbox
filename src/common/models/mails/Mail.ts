import { DateString, getRandomId } from "common";
import { Insight } from "./Insight";
import { Model } from "../Model";

export interface MailAddressValueType {
  address?: string;
  name?: string;
}

@Model.prefillable
export class MailAddressValue
  extends Model<MailAddressValue>
  implements MailAddressValueType
{
  address?: string;
  name?: string;
}

export interface MailAddressType {
  value: MailAddressValueType[];
  text: string;
}

@Model.prefillable
export class MailAddress extends Model<MailAddress> implements MailAddressType {
  value: MailAddressValue[] = [];
  text = "";
}

export interface AttachmentType {
  content: { data: string };
  contentType: string;
  filename: string;
  size: number;
}

@Model.prefillable
export class Attachment extends Model<Attachment> implements AttachmentType {
  content: { data: string } = { data: "" };
  contentType: string = "text/plain";
  filename: string = "unnamed_file";
  size: number = 0;
}

export interface MailUidType {
  domain: number;
  account: number;
}

@Model.prefillable
export class MailUid extends Model<MailUid> implements MailUidType {
  domain = 0;
  account = 0;
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
  insight?: Insight;
  uid: MailUidType;
}

@Model.prefillable
export class Mail extends Model<Mail> implements MailType {
  attachments?: AttachmentType[];
  from?: MailAddressType;
  to?: MailAddressType;
  cc?: MailAddressType;
  bcc?: MailAddressType;
  replyTo?: MailAddressType;
  envelopeFrom?: MailAddressValueType[];
  envelopeTo: MailAddressValueType[] = [];
  date: DateString = new Date().toISOString();
  html: string = "";
  text: string = "";
  subject: string = "";
  messageId: string = getRandomId();
  read: boolean = false;
  saved: boolean = false;
  sent: boolean = false;
  insight?: Insight;
  uid = new MailUid();
}
