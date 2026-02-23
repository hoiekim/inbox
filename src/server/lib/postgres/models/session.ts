import {
  SESSION_ID,
  SESSION_USER_ID,
  SESSION_USERNAME,
  SESSION_EMAIL,
  COOKIE_ORIGINAL_MAX_AGE,
  COOKIE_MAX_AGE,
  COOKIE_SIGNED,
  COOKIE_EXPIRES,
  COOKIE_HTTP_ONLY,
  COOKIE_PATH,
  COOKIE_DOMAIN,
  COOKIE_SECURE,
  COOKIE_SAME_SITE,
  UPDATED,
  SESSIONS,
} from "./common";
import { Model, createTable } from "./base";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isNullableNumber = (v: unknown): v is number | null =>
  v === null || typeof v === "number";
const isNullableBoolean = (v: unknown): v is boolean | null =>
  v === null || typeof v === "boolean";

export interface SessionJSON {
  session_id: string;
  session_user_id: string;
  session_username: string;
  session_email: string;
  cookie_original_max_age: number | null;
  cookie_max_age: number | null;
  cookie_signed: boolean | null;
  cookie_expires: string | null;
  cookie_http_only: boolean | null;
  cookie_path: string | null;
  cookie_domain: string | null;
  cookie_secure: string | null;
  cookie_same_site: string | null;
}

const sessionSchema = {
  [SESSION_ID]: "VARCHAR(255) PRIMARY KEY",
  [SESSION_USER_ID]: "UUID NOT NULL",
  [SESSION_USERNAME]: "VARCHAR(255) NOT NULL",
  [SESSION_EMAIL]: "VARCHAR(255) NOT NULL",
  [COOKIE_ORIGINAL_MAX_AGE]: "BIGINT",
  [COOKIE_MAX_AGE]: "BIGINT",
  [COOKIE_SIGNED]: "BOOLEAN",
  [COOKIE_EXPIRES]: "TIMESTAMPTZ",
  [COOKIE_HTTP_ONLY]: "BOOLEAN",
  [COOKIE_PATH]: "TEXT",
  [COOKIE_DOMAIN]: "TEXT",
  [COOKIE_SECURE]: "VARCHAR(10)",
  [COOKIE_SAME_SITE]: "VARCHAR(20)",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type SessionSchema = typeof sessionSchema;

export class SessionModel extends Model<SessionJSON, SessionSchema> {
  declare session_id: string;
  declare session_user_id: string;
  declare session_username: string;
  declare session_email: string;
  declare cookie_original_max_age: number | null;
  declare cookie_max_age: number | null;
  declare cookie_signed: boolean | null;
  declare cookie_expires: string | null;
  declare cookie_http_only: boolean | null;
  declare cookie_path: string | null;
  declare cookie_domain: string | null;
  declare cookie_secure: string | null;
  declare cookie_same_site: string | null;
  declare updated: string;

  static typeChecker = {
    session_id: isString,
    session_user_id: isString,
    session_username: isString,
    session_email: isString,
    cookie_original_max_age: isNullableNumber,
    cookie_max_age: isNullableNumber,
    cookie_signed: isNullableBoolean,
    cookie_expires: isNullableString,
    cookie_http_only: isNullableBoolean,
    cookie_path: isNullableString,
    cookie_domain: isNullableString,
    cookie_secure: isNullableString,
    cookie_same_site: isNullableString,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SessionModel.typeChecker);
  }

  toJSON(): SessionJSON {
    return {
      session_id: this.session_id,
      session_user_id: this.session_user_id,
      session_username: this.session_username,
      session_email: this.session_email,
      cookie_original_max_age: this.cookie_original_max_age,
      cookie_max_age: this.cookie_max_age,
      cookie_signed: this.cookie_signed,
      cookie_expires: this.cookie_expires,
      cookie_http_only: this.cookie_http_only,
      cookie_path: this.cookie_path,
      cookie_domain: this.cookie_domain,
      cookie_secure: this.cookie_secure,
      cookie_same_site: this.cookie_same_site,
    };
  }
}

export const sessionsTable = createTable({
  name: SESSIONS,
  primaryKey: SESSION_ID,
  schema: sessionSchema,
  ModelClass: SessionModel,
  supportsSoftDelete: false,
  indexes: [{ column: SESSION_USER_ID }, { column: COOKIE_EXPIRES }],
});

export const sessionColumns = Object.keys(sessionsTable.schema);
