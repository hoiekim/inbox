import { SignedUser } from "common";
import type { HttpRequest } from "./request";

/**
 * Attaches `user` to a freshly generated session id. Every route that turns an
 * anonymous caller into an authenticated one issues the session through here.
 *
 * The id the caller arrived with is never carried across the privilege
 * transition: a `connect.sid` planted before the call would otherwise come back
 * as an authenticated cookie that whoever planted it can replay. Reissuing also
 * replaces a store row that a password rotation has already deleted.
 *
 * The assignment waits for the reissue, so a session that could not be reissued
 * is left anonymous rather than handed the identity on its existing id.
 */
export const issueAuthenticatedSession = async (req: HttpRequest, user: SignedUser) => {
  await req.session.regenerate();
  req.session.user = user;
};
