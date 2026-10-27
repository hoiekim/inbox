import { SignedUser, SignedUserType } from "./User";
import { Model } from "../Model";

/**
 * A session cookie's attributes as the server holds them while handling a
 * request.
 */
export interface RuntimeCookieType {
  originalMaxAge: number | null;
  maxAge?: number;
  signed?: boolean;
  _expires?: Date;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  secure?: boolean | "auto";
  sameSite?: boolean | "lax" | "strict" | "none";
}

export class RuntimeCookie
  extends Model<RuntimeCookie>
  implements RuntimeCookieType
{
  declare secure?: boolean | "auto";
  declare sameSite?: boolean | "lax" | "strict" | "none";
  declare originalMaxAge: number | null;
  declare maxAge?: number;
  declare signed?: boolean;
  declare httpOnly?: boolean;
  declare path?: string;
  declare domain?: string;
  declare _expires?: Date;

  constructor(data?: Partial<RuntimeCookie>) {
    super(data);
    if (!data?.originalMaxAge) this.originalMaxAge = null;
  }
}

/**
 * Redefines some properties as they should be stringified before storing in the database.
 */
export type CookieType = Omit<RuntimeCookieType, "secure" | "sameSite"> & {
  secure?: string;
  sameSite?: string;
};

export class Cookie extends Model<Cookie> implements CookieType {
  declare secure?: string;
  declare sameSite?: string;
  declare originalMaxAge: number | null;
  declare maxAge?: number;
  declare signed?: boolean;
  declare httpOnly?: boolean;
  declare path?: string;
  declare domain?: string;
  declare _expires?: Date;

  constructor(data?: Partial<Cookie>) {
    super(data);
    if (!data?.originalMaxAge) this.originalMaxAge = null;
  }
}

/** A session as the server holds it while handling a request. */
export interface RuntimeSessionType {
  user: SignedUser;
  cookie: RuntimeCookieType;
}

export class RuntimeSession
  extends Model<RuntimeSession>
  implements RuntimeSessionType
{
  declare user: SignedUser;
  declare cookie: RuntimeCookie;

  constructor(data?: Partial<RuntimeSession>) {
    super(data);
    this.user = new SignedUser(data?.user);
    this.cookie = new RuntimeCookie(data?.cookie);
  }
}

/**
 * Redefines 'cookie' property to make it compatible with database storage.
 */
export interface SessionType {
  cookie: CookieType;
  user: SignedUserType;
}

export class Session extends Model<Session> implements SessionType {
  declare user: SignedUser;
  declare cookie: Cookie;

  constructor(data?: Partial<Session>) {
    super(data);
    this.user = new SignedUser(data?.user);
    this.cookie = new Cookie(data?.cookie);
  }
}
