import { AttachmentType, MailAddressType } from "./Mail";
import { Insight } from "./Insight";

export interface MailHeaderData {
  id: string;
  read: boolean;
  date: string;
  subject: string;
  from?: MailAddressType;
  to?: MailAddressType;
  cc?: MailAddressType;
  bcc?: MailAddressType;
  label?: string;
  insight?: Insight;
}

export interface MailBodyData {
  id: string;
  html: string;
  attachments?: AttachmentType[];
  messageId: string;
  insight?: Insight;
}

export interface MailSearchResult {
  id: string;
  subject: string;
  date: string;
  from?: MailAddressType;
  to?: MailAddressType;
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
