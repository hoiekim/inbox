import { PushSubscription } from "web-push";
import { Insight } from "server";

export type DateString = string;

export interface MailAddressValue {
  address: string;
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
  attachments: Attachment[];
  // TODO: DB needs migration for dynamic Array to be consistent Array
  from: MailAddress;
  to: MailAddress;
  cc?: MailAddress;
  bcc?: MailAddress;
  envelopeFrom: MailAddressValue[];
  envelopeTo: MailAddressValue[];
  replyTo?: MailAddress;
  date: DateString;
  html: string;
  text: string;
  subject: string;
  messageId?: string;
  read: boolean;
  label?: string;
  insight?: Insight;
}

export interface User {
  id: string;
  email: string;
  username: string;
  password: string;
  token?: string;
  expiry?: DateString;
}

export interface Document {
  type: string;
  mail?: Mail;
  user?: User;
  push_subscription?: PushSubscription;
  updated: DateString;
}

export default Document;
