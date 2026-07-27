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
// future custom mailbox), so a single scalar `uid_account` on the mail row
// assigned at receive time — scoped to `envelope_to` only — collided within
// a single mailbox view when a mail surfaced in a folder that wasn't its
// envelope_to account (issue #702 bug 1). Splitting the assignment out to
// its own per-(user, mailbox, mail) row lets a mail carry a distinct UID
// in every mailbox it appears in, and lets those UIDs be allocated lazily
// on first FETCH of the folder instead of eagerly on receive.
//
// `mailbox` holds the full IMAP path — `INBOX`, `Sent Messages`,
// `INBOX/accounts/<name>`, and any user-defined path in the future — so
// extending to custom mailboxes needs no schema change.
//
// The counter (mail_uid_counters, kind + scope + sent) stays as the
// authoritative UID source; this table records the per-mail assignment
// consumed from it.
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
    // RFC 3501 §2.3.1.1 — UIDs strictly unique per mailbox. Doubles as the
    // view-order index (SELECT … WHERE user, mailbox match ORDER BY uid ASC
    // uses this prefix). Also load-bearing for the insert path's
    // ON CONFLICT DO NOTHING — a losing racer that reserved a duplicate UID
    // falls through and re-reads.
    `UNIQUE (${USER_ID}, ${MAILBOX}, ${UID})`,
    // Cascade delete when the mail row is expunged so the mapping doesn't
    // leak. mails PK is `mail_id`; the (user_id, mail_id) pair is
    // consistent by transitive relation through the mail row.
    `FOREIGN KEY (${MAIL_ID}) REFERENCES ${MAILS}(${MAIL_ID}) ON DELETE CASCADE`,
  ],
  indexes: [],
  ModelClass: MailMailboxUidModel,
  supportsSoftDelete: false,
});

export const mailMailboxUidColumns = Object.keys(mailMailboxUidTable.schema);
