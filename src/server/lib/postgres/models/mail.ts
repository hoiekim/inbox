import {
  MAIL_ID,
  USER_ID,
  MESSAGE_ID,
  SUBJECT,
  DATE,
  HTML,
  TEXT,
  FROM_ADDRESS,
  FROM_TEXT,
  TO_ADDRESS,
  TO_TEXT,
  CC_ADDRESS,
  CC_TEXT,
  BCC_ADDRESS,
  BCC_TEXT,
  REPLY_TO_ADDRESS,
  REPLY_TO_TEXT,
  ENVELOPE_FROM,
  ENVELOPE_TO,
  ATTACHMENTS,
  READ,
  SAVED,
  SENT,
  DELETED,
  DRAFT,
  ANSWERED,
  EXPUNGED,
  INSIGHT,
  UID_DOMAIN,
  UID_ACCOUNT,
  UPDATED,
  MAILS,
  SPAM_SCORE,
  SPAM_REASONS,
  IS_SPAM,
} from "./common";
import { Model, ModelValidationError, createTable, validateObject } from "./base";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNullableObject = (v: unknown): v is object | null =>
  v === null || typeof v === "object";
const isNullableArray = (v: unknown): v is unknown[] | null =>
  v === null || Array.isArray(v);

export interface MailJSON {
  mail_id: string;
  user_id: string;
  message_id: string;
  subject: string;
  date: string;
  html: string;
  text: string;
  from_address: object | null;
  from_text: string | null;
  to_address: object | null;
  to_text: string | null;
  cc_address: object | null;
  cc_text: string | null;
  bcc_address: object | null;
  bcc_text: string | null;
  reply_to_address: object | null;
  reply_to_text: string | null;
  envelope_from: object | null;
  envelope_to: object | null;
  attachments: object | null;
  read: boolean;
  saved: boolean;
  sent: boolean;
  deleted: boolean;
  draft: boolean;
  answered: boolean;
  expunged: boolean;
  insight: object | null;
  uid_domain: number;
  uid_account: number;
  spam_score: number;
  spam_reasons: string[] | null;
  is_spam: boolean;
}

const mailSchema = {
  [MAIL_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [MESSAGE_ID]: "VARCHAR(512) NOT NULL",
  [SUBJECT]: "TEXT NOT NULL DEFAULT ''",
  [DATE]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
  [HTML]: "TEXT NOT NULL DEFAULT ''",
  [TEXT]: "TEXT NOT NULL DEFAULT ''",
  [FROM_ADDRESS]: "JSONB",
  [FROM_TEXT]: "TEXT",
  [TO_ADDRESS]: "JSONB",
  [TO_TEXT]: "TEXT",
  [CC_ADDRESS]: "JSONB",
  [CC_TEXT]: "TEXT",
  [BCC_ADDRESS]: "JSONB",
  [BCC_TEXT]: "TEXT",
  [REPLY_TO_ADDRESS]: "JSONB",
  [REPLY_TO_TEXT]: "TEXT",
  [ENVELOPE_FROM]: "JSONB",
  [ENVELOPE_TO]: "JSONB",
  [ATTACHMENTS]: "JSONB",
  [READ]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [SAVED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [SENT]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [DELETED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [DRAFT]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [ANSWERED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [EXPUNGED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [INSIGHT]: "JSONB",
  [UID_DOMAIN]: "INTEGER NOT NULL DEFAULT 0",
  [UID_ACCOUNT]: "INTEGER NOT NULL DEFAULT 0",
  [SPAM_SCORE]: "INTEGER NOT NULL DEFAULT 0",
  [SPAM_REASONS]: "JSONB",
  [IS_SPAM]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  search_vector: "TSVECTOR",
};

type MailSchema = typeof mailSchema;

export class MailModel extends Model<MailJSON, MailSchema> {
  declare mail_id: string;
  declare user_id: string;
  declare message_id: string;
  declare subject: string;
  declare date: string;
  declare html: string;
  declare text: string;
  declare from_address: object | null;
  declare from_text: string | null;
  declare to_address: object | null;
  declare to_text: string | null;
  declare cc_address: object | null;
  declare cc_text: string | null;
  declare bcc_address: object | null;
  declare bcc_text: string | null;
  declare reply_to_address: object | null;
  declare reply_to_text: string | null;
  declare envelope_from: object | null;
  declare envelope_to: object | null;
  declare attachments: object | null;
  declare read: boolean;
  declare saved: boolean;
  declare sent: boolean;
  declare deleted: boolean;
  declare draft: boolean;
  declare answered: boolean;
  declare expunged: boolean;
  declare insight: object | null;
  declare uid_domain: number;
  declare uid_account: number;
  declare spam_score: number;
  declare spam_reasons: string[] | null;
  declare is_spam: boolean;
  declare updated: string;

  static typeChecker = {
    mail_id: isString,
    user_id: isString,
    message_id: isString,
    subject: isString,
    date: isString,
    html: isString,
    text: isString,
    from_address: isNullableObject,
    from_text: isNullableString,
    to_address: isNullableObject,
    to_text: isNullableString,
    cc_address: isNullableObject,
    cc_text: isNullableString,
    bcc_address: isNullableObject,
    bcc_text: isNullableString,
    reply_to_address: isNullableObject,
    reply_to_text: isNullableString,
    envelope_from: isNullableObject,
    envelope_to: isNullableObject,
    attachments: isNullableObject,
    read: isBoolean,
    saved: isBoolean,
    sent: isBoolean,
    deleted: isBoolean,
    draft: isBoolean,
    answered: isBoolean,
    expunged: isBoolean,
    insight: isNullableObject,
    uid_domain: isNumber,
    uid_account: isNumber,
    spam_score: isNumber,
    spam_reasons: isNullableArray,
    is_spam: isBoolean,
    updated: isNullableString,
    search_vector: isNullableString,
  };

  constructor(data: unknown) {
    super(data, MailModel.typeChecker);
  }

  toJSON(): MailJSON {
    return {
      mail_id: this.mail_id,
      user_id: this.user_id,
      message_id: this.message_id,
      subject: this.subject,
      date: this.date,
      html: this.html,
      text: this.text,
      from_address: this.from_address,
      from_text: this.from_text,
      to_address: this.to_address,
      to_text: this.to_text,
      cc_address: this.cc_address,
      cc_text: this.cc_text,
      bcc_address: this.bcc_address,
      bcc_text: this.bcc_text,
      reply_to_address: this.reply_to_address,
      reply_to_text: this.reply_to_text,
      envelope_from: this.envelope_from,
      envelope_to: this.envelope_to,
      attachments: this.attachments,
      read: this.read,
      saved: this.saved,
      sent: this.sent,
      deleted: this.deleted,
      draft: this.draft,
      answered: this.answered,
      expunged: this.expunged,
      insight: this.insight,
      uid_domain: this.uid_domain,
      uid_account: this.uid_account,
      spam_score: this.spam_score,
      spam_reasons: this.spam_reasons,
      is_spam: this.is_spam,
    };
  }
}

/**
 * A partial view of a MailModel with only the requested fields validated.
 * Use when querying a subset of mail columns (e.g., IMAP FETCH with specific fields).
 *
 * Validates:
 * 1. Each requested field name exists in MailModel (unknown column → throws)
 * 2. Each selected field's value passes the MailModel type check
 *
 * Usage:
 *   const partial = new PartialMailModel(["mail_id", "subject", "read"], row);
 *   partial.subject // string | undefined
 */
export class PartialMailModel {
  static readonly validFields: ReadonlySet<string> = new Set(
    Object.keys(MailModel.typeChecker)
  );

  readonly selectedFields: ReadonlySet<string>;

  // All MailModel fields exposed as optional properties
  readonly mail_id?: string;
  readonly user_id?: string;
  readonly message_id?: string;
  readonly subject?: string;
  readonly date?: string;
  readonly html?: string;
  readonly text?: string;
  readonly from_address?: object | null;
  readonly from_text?: string | null;
  readonly to_address?: object | null;
  readonly to_text?: string | null;
  readonly cc_address?: object | null;
  readonly cc_text?: string | null;
  readonly bcc_address?: object | null;
  readonly bcc_text?: string | null;
  readonly reply_to_address?: object | null;
  readonly reply_to_text?: string | null;
  readonly envelope_from?: object | null;
  readonly envelope_to?: object | null;
  readonly attachments?: object | null;
  readonly read?: boolean;
  readonly saved?: boolean;
  readonly sent?: boolean;
  readonly deleted?: boolean;
  readonly draft?: boolean;
  readonly answered?: boolean;
  readonly expunged?: boolean;
  readonly insight?: object | null;
  readonly uid_domain?: number;
  readonly uid_account?: number;
  readonly spam_score?: number;
  readonly spam_reasons?: string[] | null;
  readonly is_spam?: boolean;
  readonly updated?: string;

  constructor(fields: string[], data: unknown) {
    // 1. Validate all field names are known MailModel columns
    const unknownFields = fields.filter(
      (f) => !PartialMailModel.validFields.has(f)
    );
    if (unknownFields.length > 0) {
      throw new ModelValidationError(
        "PartialMailModel",
        unknownFields.map((f) => `Unknown field: ${f}`)
      );
    }

    // 2. Build a checker for only the requested fields and validate
    const partialChecker = Object.fromEntries(
      fields.map((f) => [
        f,
        MailModel.typeChecker[f as keyof typeof MailModel.typeChecker],
      ])
    ) as Record<string, (v: unknown) => boolean>;

    const errors = validateObject(data, partialChecker);
    if (errors.length > 0) {
      throw new ModelValidationError("PartialMailModel", errors);
    }

    // 3. Assign only the selected fields
    this.selectedFields = new Set(fields);
    const self = this as Record<string, unknown>;
    const obj = data as Record<string, unknown>;
    for (const field of fields) {
      self[field] = obj[field];
    }
  }
}

export const mailsTable = createTable<MailJSON, MailSchema, MailModel>({
  name: MAILS,
  primaryKey: MAIL_ID,
  schema: mailSchema,
  constraints: ["UNIQUE (user_id, message_id)"],
  indexes: [
    { column: USER_ID },
    { column: DATE },
    { column: SENT },
    { column: READ },
    { column: SAVED },
    { column: UID_DOMAIN },
    { column: UID_ACCOUNT },
    { column: IS_SPAM },
    { column: EXPUNGED },
  ],
  ModelClass: MailModel,
  supportsSoftDelete: false,
});

export const mailColumns = Object.keys(mailsTable.schema);
