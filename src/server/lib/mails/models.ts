import { Attachment, Insight, MailAddress } from "server";

/**
 * I know it's annoying. Why are some types dynamically array or not array?
 * It's just how our mail receiving framework handles the incoming mail data.
 * And that's why we need an extra process to make it into consistently an array.
 */
export interface IncomingMail {
  attachments?: IncomingAttachment | IncomingAttachment[];
  from?: IncomingMailAddress | IncomingMailAddress[];
  to?: IncomingMailAddress | IncomingMailAddress[];
  cc?: IncomingMailAddress | IncomingMailAddress[];
  bcc?: IncomingMailAddress | IncomingMailAddress[];
  replyTo?: IncomingMailAddress | IncomingMailAddress[];
  envelopeFrom?: IncomingMailAddressValue | IncomingMailAddressValue[];
  envelopeTo?: IncomingMailAddressValue | IncomingMailAddressValue[];
  date?: string;
  html?: string;
  text?: string;
  subject?: string;
  messageId?: string;
}

export interface IncomingAttachment {
  content: { data: Buffer } | string;
  contentType: string;
  filename: string;
}

export interface IncomingMailAddress {
  value: IncomingMailAddressValue | IncomingMailAddressValue[];
  text: string;
}

export interface IncomingMailAddressValue {
  address?: string;
  name?: string;
  /**
   * I don't know what this data is supposed to look like.
   */
  group?: any | any[];
}

export interface MailHeaderData {
  id: string;
  read: boolean;
  date: string;
  subject: string;
  from?: MailAddress;
  to?: MailAddress;
  cc?: MailAddress;
  bcc?: MailAddress;
  label?: string;
  insight?: Insight;
}

export interface MailBodyData {
  id: string;
  html: string;
  attachments?: Attachment[];
  messageId?: string;
  insight?: Insight;
}

export interface MailSearchResult {
  id: string;
  subject: string;
  date: string;
  from?: MailAddress;
  to?: MailAddress;
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
