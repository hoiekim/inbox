import { Model, createTable } from "./base";

// Table and column names
export const MAILBOXES = "mailboxes";
export const MAILBOX_ID = "mailbox_id";
export const MAILBOX_USER_ID = "user_id";
export const MAILBOX_NAME = "name";
export const MAILBOX_ADDRESS = "address"; // email address associated with this mailbox
export const MAILBOX_PARENT_ID = "parent_id";
export const MAILBOX_UID_VALIDITY = "uid_validity";
export const MAILBOX_UID_NEXT = "uid_next";
export const MAILBOX_SUBSCRIBED = "subscribed";
export const MAILBOX_SPECIAL_USE = "special_use"; // \Inbox, \Sent, \Drafts, \Trash, etc.
export const MAILBOX_CREATED = "created";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export interface MailboxJSON {
  mailbox_id: string;
  user_id: string;
  name: string;
  address: string | null;
  parent_id: string | null;
  uid_validity: number;
  uid_next: number;
  subscribed: boolean;
  special_use: string | null;
  created: string;
}

const mailboxSchema = {
  [MAILBOX_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [MAILBOX_USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [MAILBOX_NAME]: "VARCHAR(255) NOT NULL",
  [MAILBOX_ADDRESS]: "VARCHAR(255)", // nullable - not all mailboxes have an address
  [MAILBOX_PARENT_ID]: "UUID REFERENCES mailboxes(mailbox_id) ON DELETE CASCADE",
  [MAILBOX_UID_VALIDITY]: "INTEGER NOT NULL DEFAULT 1",
  [MAILBOX_UID_NEXT]: "INTEGER NOT NULL DEFAULT 1",
  [MAILBOX_SUBSCRIBED]: "BOOLEAN NOT NULL DEFAULT TRUE",
  [MAILBOX_SPECIAL_USE]: "VARCHAR(50)", // \Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive
  [MAILBOX_CREATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type MailboxSchema = typeof mailboxSchema;

export class MailboxModel extends Model<MailboxJSON, MailboxSchema> {
  declare mailbox_id: string;
  declare user_id: string;
  declare name: string;
  declare address: string | null;
  declare parent_id: string | null;
  declare uid_validity: number;
  declare uid_next: number;
  declare subscribed: boolean;
  declare special_use: string | null;
  declare created: string;

  static typeChecker = {
    mailbox_id: isString,
    user_id: isString,
    name: isString,
    address: isNullableString,
    parent_id: isNullableString,
    uid_validity: isNumber,
    uid_next: isNumber,
    subscribed: isBoolean,
    special_use: isNullableString,
    created: isNullableString,
  };

  constructor(data: unknown) {
    super(data, MailboxModel.typeChecker);
  }

  toJSON(): MailboxJSON {
    return {
      mailbox_id: this.mailbox_id,
      user_id: this.user_id,
      name: this.name,
      address: this.address,
      parent_id: this.parent_id,
      uid_validity: this.uid_validity,
      uid_next: this.uid_next,
      subscribed: this.subscribed,
      special_use: this.special_use,
      created: this.created,
    };
  }
}

export const mailboxesTable = createTable({
  name: MAILBOXES,
  primaryKey: MAILBOX_ID,
  schema: mailboxSchema,
  ModelClass: MailboxModel,
  supportsSoftDelete: false,
  indexes: [
    { column: MAILBOX_USER_ID },
    { column: MAILBOX_NAME },
    { column: MAILBOX_ADDRESS },
    { column: MAILBOX_PARENT_ID },
  ],
});

export const mailboxColumns = Object.keys(mailboxesTable.schema);
