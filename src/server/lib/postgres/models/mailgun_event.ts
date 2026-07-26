import { Model, createTable } from "./base";
import { MESSAGE_ID, UPDATED } from "./common";

export const MAILGUN_EVENTS = "mailgun_events";
export const EVENT_ID = "event_id";
export const EVENT = "event";
export const RECIPIENT = "recipient";
export const SEVERITY = "severity";
export const REASON = "reason";
export const OCCURRED_AT = "occurred_at";
export const RECEIVED_AT = "received_at";
export const RAW = "raw";

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isOptionalString = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface MailgunEventJSON {
  event_id: string;
  event: string;
  message_id: string | null;
  recipient: string | null;
  severity: string | null;
  reason: string | null;
  occurred_at: string;
  received_at: string;
  raw: Record<string, unknown>;
  updated?: string;
}

const schema = {
  [EVENT_ID]: "TEXT PRIMARY KEY",
  [EVENT]: "TEXT NOT NULL",
  [MESSAGE_ID]: "TEXT",
  [RECIPIENT]: "TEXT",
  [SEVERITY]: "TEXT",
  [REASON]: "TEXT",
  [OCCURRED_AT]: "TIMESTAMPTZ NOT NULL",
  [RECEIVED_AT]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
  [RAW]: "JSONB NOT NULL",
  [UPDATED]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
};

type MailgunEventSchema = typeof schema;

export class MailgunEventModel extends Model<MailgunEventJSON, MailgunEventSchema> {
  declare event_id: string;
  declare event: string;
  declare message_id: string | null;
  declare recipient: string | null;
  declare severity: string | null;
  declare reason: string | null;
  declare occurred_at: string;
  declare received_at: string;
  declare raw: Record<string, unknown>;
  declare updated?: string;

  static typeChecker = {
    event_id: isString,
    event: isString,
    message_id: isNullableString,
    recipient: isNullableString,
    severity: isNullableString,
    reason: isNullableString,
    occurred_at: isString,
    received_at: isString,
    raw: isObject,
    updated: isOptionalString,
  };

  constructor(data: unknown) {
    super(data, MailgunEventModel.typeChecker);
  }

  toJSON(): MailgunEventJSON {
    return {
      event_id: this.event_id,
      event: this.event,
      message_id: this.message_id,
      recipient: this.recipient,
      severity: this.severity,
      reason: this.reason,
      occurred_at: this.occurred_at,
      received_at: this.received_at,
      raw: this.raw,
      updated: this.updated,
    };
  }
}

export const mailgunEventsTable = createTable({
  name: MAILGUN_EVENTS,
  primaryKey: EVENT_ID,
  schema,
  ModelClass: MailgunEventModel,
  supportsSoftDelete: false,
  indexes: [
    { column: MESSAGE_ID },
    { column: EVENT },
    { column: OCCURRED_AT },
  ],
});

export const mailgunEventColumns = Object.keys(mailgunEventsTable.schema);
