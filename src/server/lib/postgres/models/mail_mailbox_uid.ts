import {
  USER_ID,
  MAILBOX,
  MAIL_ID,
  UID,
  MAIL_MAILBOX_UID,
  MAILS,
} from "./common";
import { Model, createTable } from "./base";

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";

export interface MailMailboxUidJSON {
  user_id: string;
  mailbox: string;
  mail_id: string;
  uid: number;
}

// Per-(user, mailbox, mail) UID assignment for IMAP folder views.
//
// A single mail can appear in multiple mailbox views (to/cc/bcc/envelope_to
// OR-containment across account inboxes; plus INBOX, Sent Messages, and any
// user-defined mailbox). Per-view UID assignment via this table lets a mail
// carry a distinct UID in every mailbox it appears in, and lets those UIDs
// be allocated lazily on first FETCH of the folder rather than eagerly on
// receive.
//
// `mailbox` holds the full IMAP path so extending to user-defined mailboxes
// needs no schema change.
//
// UID reservation goes through `mail_uid_counters` (the authoritative
// counter); this table records the per-mail assignment consumed from it.
const mailMailboxUidSchema = {
  [USER_ID]: "UUID NOT NULL",
  [MAILBOX]: "TEXT NOT NULL",
  [MAIL_ID]: "UUID NOT NULL",
  [UID]: "BIGINT NOT NULL",
};

type MailMailboxUidSchema = typeof mailMailboxUidSchema;

export class MailMailboxUidModel extends Model<
  MailMailboxUidJSON,
  MailMailboxUidSchema
> {
  declare user_id: string;
  declare mailbox: string;
  declare mail_id: string;
  declare uid: number;

  static typeChecker = {
    user_id: isString,
    mailbox: isString,
    mail_id: isString,
    uid: isNumber,
  };

  constructor(data: unknown) {
    super(data, MailMailboxUidModel.typeChecker);
  }

  toJSON(): MailMailboxUidJSON {
    return {
      user_id: this.user_id,
      mailbox: this.mailbox,
      mail_id: this.mail_id,
      uid: this.uid,
    };
  }
}

export const mailMailboxUidTable = createTable({
  name: MAIL_MAILBOX_UID,
  // No surrogate id — the natural key is the composite PK below. `primaryKey`
  // is required by the framework but only used by id-based helpers this
  // table never calls; the real key is the PRIMARY KEY constraint.
  primaryKey: USER_ID,
  schema: mailMailboxUidSchema,
  constraints: [
    // Natural PK: one UID per (user, mailbox, mail).
    `PRIMARY KEY (${USER_ID}, ${MAILBOX}, ${MAIL_ID})`,
    `UNIQUE (${USER_ID}, ${MAILBOX}, ${UID})`,
    // Cascade delete when the mail row is deleted so the mapping doesn't
    // leak. Postgres does not auto-index the referencing column, so the
    // `indexes` entry below stands the FK check up as a lookup instead of
    // a seq scan; the same index also serves the "given a mail_id, list
    // the mailbox views it's mapped in" reverse lookup (COPY/MOVE dest).
    `FOREIGN KEY (${MAIL_ID}) REFERENCES ${MAILS}(${MAIL_ID}) ON DELETE CASCADE`,
  ],
  indexes: [{ column: MAIL_ID }],
  ModelClass: MailMailboxUidModel,
  supportsSoftDelete: false,
});

export const mailMailboxUidColumns = Object.keys(mailMailboxUidTable.schema);
