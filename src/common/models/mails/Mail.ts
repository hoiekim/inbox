import { DateString, getRandomId } from "common";
import { Insight } from "./Insight";
import { Model } from "../Model";

export interface MailAddressValueType {
  address?: string;
  name?: string;
}

export interface MailAddressType {
  value: MailAddressValueType[];
  text: string;
}

export class MailAddress extends Model<MailAddress> implements MailAddressType {
  value: MailAddressValueType[] = [];
  text: string = "";
}

export interface AttachmentType {
  content: { data: string };
  contentType: string;
  filename: string;
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
}
