import {
  USER_ID,
  UID_KIND,
  UID_SCOPE,
  SENT,
  LAST_UID,
  MAIL_UID_COUNTERS,
} from "./common";
import { Model, createTable } from "./base";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export interface MailUidCounterJSON {
  user_id: string;
  uid_kind: string;
  uid_scope: string;
  sent: boolean;
  last_uid: number;
}

// Per-(user, kind, scope, sent) durable UID counter — the IMAP UIDNEXT model.
// `uid_kind` discriminates the domain-wide sequence ("domain") from the
// per-account sequence ("account") so an account whose address normalizes to ""
// can never share a row with the domain counter. `last_uid` is the most recently
// assigned UID; assignment is the atomic increment in getDomainUidNext /
// getAccountUidNext, which is what makes concurrent mail receipt race-free
// (a bare MAX(uid)+1 read could not).
const mailUidCounterSchema = {
  [USER_ID]: "UUID NOT NULL",
  [UID_KIND]: "VARCHAR(16) NOT NULL",
  [UID_SCOPE]: "TEXT NOT NULL",
  [SENT]: "BOOLEAN NOT NULL",
  [LAST_UID]: "BIGINT NOT NULL",
};

type MailUidCounterSchema = typeof mailUidCounterSchema;

export class MailUidCounterModel extends Model<
  MailUidCounterJSON,
  MailUidCounterSchema
> {
  declare user_id: string;
  declare uid_kind: string;
  declare uid_scope: string;
  declare sent: boolean;
  declare last_uid: number;

  static typeChecker = {
    user_id: isString,
    uid_kind: isString,
    uid_scope: isString,
    sent: isBoolean,
    last_uid: isNumber,
  };

  constructor(data: unknown) {
    super(data, MailUidCounterModel.typeChecker);
  }

  toJSON(): MailUidCounterJSON {
    return {
      user_id: this.user_id,
      uid_kind: this.uid_kind,
      uid_scope: this.uid_scope,
      sent: this.sent,
      last_uid: this.last_uid,
    };
  }
}

export const mailUidCountersTable = createTable({
  name: MAIL_UID_COUNTERS,
  // No surrogate id — the natural key is the composite below. primaryKey is
  // required by the framework but only used by id-based helpers this table
  // never calls; the real key is the PRIMARY KEY constraint.
  primaryKey: USER_ID,
  schema: mailUidCounterSchema,
  constraints: [
    `PRIMARY KEY (${USER_ID}, ${UID_KIND}, ${UID_SCOPE}, ${SENT})`,
  ],
  ModelClass: MailUidCounterModel,
  supportsSoftDelete: false,
});

export const mailUidCounterColumns = Object.keys(mailUidCountersTable.schema);
