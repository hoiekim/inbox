import { DateString } from "common";
import { Insight } from "server";

export interface MailAddressValue {
  address?: string;
  name?: string;
}

export interface MailAddress {
  value: MailAddressValue[];
  text: string;
}

export interface Attachment {
  content: { data: string };
  contentType: string;
  filename: string;
}

export interface Mail {
  attachments?: Attachment[];
  from?: MailAddress;
  to?: MailAddress;
  cc?: MailAddress;
  bcc?: MailAddress;
  replyTo?: MailAddress;
  envelopeFrom?: MailAddressValue[];
  envelopeTo: MailAddressValue[];
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

// @Model.prefillable
// export class Mail extends Model<Mail> implements MailType {
//   attachments?: Attachment[];
//   from?: MailAddress;
//   to?: MailAddress;
//   cc?: MailAddress;
//   bcc?: MailAddress;
//   replyTo?: MailAddress;
//   envelopeFrom?: MailAddressValue[];
//   envelopeTo: MailAddressValue[] = [];
//   date: DateString = new Date().toISOString();
//   html: string = "";
//   text: string = "";
//   subject: string = "";
//   messageId: string = getRandomId();
//   read: boolean = false;
//   saved: boolean = false;
//   sent: boolean = false;
//   insight?: Insight;
// }
