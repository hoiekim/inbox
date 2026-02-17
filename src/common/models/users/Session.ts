import { SessionData as _Session, Cookie as _Cookie } from "express-session";
import { SignedUser, SignedUserType } from "./User";
import { Model } from "../Model";

/**
 * The REAL `Cookie` type that's used by express-session in runtime.
 */
export type RuntimeCookieType = Omit<_Cookie, "expires"> & { _expires?: Date };

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

/**
 * `SessionData` imported from express-session contains cookie property which is
 * `Cookie` type, which doesn't match with runtime cookie object. `RealSessionData`
 * tries to define what's actually used in runtime.
 */
export type RuntimeSessionType = Omit<_Session, "cookie"> & {
  cookie: RuntimeCookieType;
};

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
export type SessionType = Omit<_Session, "cookie"> & {
  cookie: CookieType;
  user: SignedUserType;
};

export class Session extends Model<Session> implements SessionType {
  declare user: SignedUser;
  declare cookie: Cookie;

  constructor(data?: Partial<Session>) {
    super(data);
    this.user = new SignedUser(data?.user);
    this.cookie = new Cookie(data?.cookie);
  }
}
