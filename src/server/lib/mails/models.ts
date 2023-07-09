import { Attachment, Insight, MailAddress, MailAddressValue } from "server";

export interface IncomingMail {
  attachments: IncomingAttachment[];
  from: IncomingMailAddress;
  to: IncomingMailAddress;
  cc?: IncomingMailAddress;
  bcc?: IncomingMailAddress;
  envelopeFrom: MailAddressValue | MailAddressValue[];
  envelopeTo: MailAddressValue | MailAddressValue[];
  replyTo?: IncomingMailAddress;
  date: string;
  html: string;
  text: string;
  subject: string;
  messageId?: string;
}

export interface IncomingAttachment {
  content: { data: Buffer } | string;
  contentType: string;
  filename: string;
}

export interface IncomingMailAddress {
  value: IncomingMailAddressValue;
  text: string;
}

/**
 * I know it's annoying. Why is this type dynamically an array or not an array?
 * It's just how our mail receiving framework handles the incoming mail data.
 * And that's why we need an extra process to make it into consistently an array.
 */
export type IncomingMailAddressValue = MailAddressValue | MailAddressValue[];

export interface MailHeaderData {
  id: string;
  read: boolean;
  date: string;
  subject: string;
  from: MailAddress;
  to: MailAddress;
  cc?: MailAddress;
  bcc?: MailAddress;
  label?: string;
  insight?: Insight;
}

export interface MailBodyData {
  id: string;
  html: string;
  attachments: Attachment[];
  messageId: string;
  insight?: Insight;
}

export interface MailSearchResult {
  id: string;
  subject: string;
  date: string;
  from: MailAddress;
  to: MailAddress;
  read: boolean;
  highlight?: {
    subject?: string[];
    text?: string[];
  };
}

export interface MailDataToSend {
  sender: string;
  senderFullName: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  inReplyTo?: string;
}
