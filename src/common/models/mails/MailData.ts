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

@Model.prefillable
export class MailHeaderData
  extends Model<MailHeaderData>
  implements MailHeaderDataType
{
  id: string = getRandomId();
  subject: string = "No Subject";
  date: DateString = new Date().toISOString();
  read: boolean = false;
  saved: boolean = false;
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

export interface MailBodyDataType {
  id: string;
  html: string;
  attachments?: AttachmentType[];
  messageId: string;
  insight?: Insight;
}

@Model.prefillable
export class MailBodyData
  extends Model<MailBodyData>
  implements MailBodyDataType
{
  id: string = getRandomId();
  html: string = "";
  attachments?: AttachmentType[];
  messageId: string = getRandomId();
  insight?: Insight;
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

@Model.prefillable
export class MailDataToSend
  extends Model<MailDataToSend>
  implements MailDataToSendType
{
  sender: string = "unknown";
  senderFullName: string = "unknown";
  to: string = "";
  cc?: string;
  bcc?: string;
  subject: string = "No Subject";
  html: string = "";
  inReplyTo?: string;
}
