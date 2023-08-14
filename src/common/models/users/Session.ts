import { SessionData as _Session, Cookie as _Cookie } from "express-session";
import { SignedUser, SignedUserType } from "./User";
import { Model } from "../Model";

/**
 * The REAL `Cookie` type that's used by express-session in runtime.
 */
export type RuntimeCookieType = Omit<_Cookie, "expires"> & { _expires?: Date };

@Model.prefillable
export class RuntimeCookie
  extends Model<RuntimeCookie>
  implements RuntimeCookieType
{
  secure?: boolean | "auto";
  sameSite?: boolean | "lax" | "strict" | "none";
  originalMaxAge: number | null = null;
  maxAge?: number;
  signed?: boolean;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  _expires?: Date;
}

/**
 * Redefines some properties as they should be stringified before storing because
 * Elasticsearch doesn't support multiple types mappings.
 */
export type CookieType = Omit<RuntimeCookieType, "secure" | "sameSite"> & {
  secure?: string;
  sameSite?: string;
};

@Model.prefillable
export class Cookie extends Model<Cookie> implements CookieType {
  secure?: string;
  sameSite?: string;
  originalMaxAge: number | null = null;
  maxAge?: number;
  signed?: boolean;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  _expires?: Date;
}

/**
 * `SessionData` imported from express-session contains cookie property which is
 * `Cookie` type, which doesn't match with runtime cookie object. `RealSessionData`
 * tries to define what's actually used in runtime.
 */
export type RuntimeSessionType = Omit<_Session, "cookie"> & {
  cookie: RuntimeCookieType;
};

@Model.prefillable
export class RuntimeSession
  extends Model<RuntimeSession>
  implements RuntimeSessionType
{
  user = new SignedUser();
  cookie = new RuntimeCookie();
}

/**
 * Redefines 'cookie' property to make it compatible with Elasticsearch mappings.
 */
export type SessionType = Omit<_Session, "cookie"> & {
  cookie: CookieType;
  user: SignedUserType;
};

@Model.prefillable
export class Session extends Model<Session> implements SessionType {
  user = new SignedUser();
  cookie = new Cookie();
}
