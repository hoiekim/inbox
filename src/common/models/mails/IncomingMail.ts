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
  content: { data: Buffer } | Buffer | string;
  contentType: string;
  filename: string;
  size: number;
}

export interface IncomingMailAddress {
  value: IncomingMailAddressValue | IncomingMailAddressValue[];
  text: string;
}

export interface IncomingMailAddressValue {
  address?: string;
  name?: string;
  /**
   * Group information for email distribution lists.
   * Structure varies by email client/server implementation.
   */
  group?: IncomingMailAddressValue | IncomingMailAddressValue[];
}
