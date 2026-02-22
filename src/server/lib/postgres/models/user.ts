import {
  USER_ID,
  USERNAME,
  PASSWORD,
  EMAIL,
  EXPIRY,
  TOKEN,
  UPDATED,
  IS_DELETED,
  USERS,
  IMAP_UID_VALIDITY,
} from "./common";
import { Schema, Model, createTable } from "./base";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const isNullableBoolean = (v: unknown): v is boolean | null =>
  v === null || typeof v === "boolean";
const isNullableNumber = (v: unknown): v is number | null =>
  v === null || typeof v === "number";

export interface MaskedUser {
  user_id: string;
  username: string;
  email?: string | null;
}

export type User = MaskedUser & { password: string };

const userSchema = {
  [USER_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USERNAME]: "VARCHAR(255) UNIQUE NOT NULL",
  [PASSWORD]: "VARCHAR(255)",
  [EMAIL]: "VARCHAR(255)",
  [EXPIRY]: "TIMESTAMPTZ",
  [TOKEN]: "VARCHAR(255)",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  [IMAP_UID_VALIDITY]: "BIGINT",
};

type UserSchema = typeof userSchema;

export class UserModel extends Model<MaskedUser, UserSchema> {
  declare user_id: string;
  declare username: string;
  declare password: string | null;
  declare email: string | null;
  declare expiry: string | null;
  declare token: string | null;
  declare updated: string;
  declare is_deleted: boolean;
  declare imap_uid_validity: number | null;

  static typeChecker = {
    user_id: isString,
    username: isString,
    password: isNullableString,
    email: isNullableString,
    expiry: isNullableString,
    token: isNullableString,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
    imap_uid_validity: isNullableNumber,
  };

  constructor(data: unknown) {
    super(data, UserModel.typeChecker);
  }

  toJSON(): MaskedUser {
    return { user_id: this.user_id, username: this.username, email: this.email };
  }

  toMaskedUser(): MaskedUser {
    return this.toJSON();
  }

  toUser(): User {
    if (this.password === null) throw new Error("User has no password set");
    return {
      user_id: this.user_id,
      username: this.username,
      password: this.password,
      email: this.email,
    };
  }
}

export const usersTable = createTable({
  name: USERS,
  primaryKey: USER_ID,
  schema: userSchema,
  ModelClass: UserModel,
  indexes: [{ column: EMAIL }],
});

export const userColumns = Object.keys(usersTable.schema);
