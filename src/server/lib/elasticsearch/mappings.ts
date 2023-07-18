import { PushSubscription } from "web-push";
import { Insight, StoredSessionData } from "server";

export type DateString = string;

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
  messageId?: string;
  read: boolean;
  saved: boolean;
  sent: boolean;
  insight?: Insight;
}

export interface User {
  id?: string;
  email?: string;
  username?: string;
  password?: string;
  token?: string;
  expiry?: DateString;
}

export type Session = StoredSessionData;

export interface Document {
  type: string;
  mail?: Mail;
  user?: User;
  session?: Session;
  push_subscription?: PushSubscription;
  updated: DateString;
}

export default Document;
