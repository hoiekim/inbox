import { MaskedUser } from "common";
import {
  getUser,
  logger,
  ADMIN_RO_USERNAME,
  resolveSessionUser,
} from "server";
import { Route } from "../route";
import { getClientIp, loginLimiter, loginIdentityOf } from "../../rate-limit";
import { issueAuthenticatedSession } from "../../issue-session";
import { verifyPassword } from "../../../verify-password";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    // Validate body shape before processing.
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "failed", message: "Invalid request body." };
    }

    const { email, username, password } = body as Record<string, unknown>;

    if (typeof password !== "string" || !password) {
      return { status: "failed", message: "Invalid credentials." };
    }
    if (email !== undefined && typeof email !== "string") {
      return { status: "failed", message: "Invalid credentials." };
    }
    if (username !== undefined && typeof username !== "string") {
      return { status: "failed", message: "Invalid credentials." };
    }

    const inputUser = { email: email as string | undefined, username: username as string | undefined };
    const user = await getUser(inputUser);
    const signedUser = user?.getSigned();

    const pwMatches = await verifyPassword(password, user?.password);

    const ip = getClientIp(req);
    // The attempted identity: failures accumulate per (ip, account) and the
    // success below forgives only this account's own bucket. The per-IP
    // aggregate is never reset here, so alternating accounts from one IP
    // cannot wipe the counter.
    const account = loginIdentityOf(req);

    if (!pwMatches || !signedUser) {
      loginLimiter.recordFailure(ip, account);
      return { status: "failed", message: "Invalid credentials." };
    }

    // Session-scoped read-only remap, shared with IMAP in read-only.ts. If the
    // effective user is missing (the read-only account was seeded before
    // admin's row exists), fall back to bad-credentials rather than issuing
    // an unremapped session.
    const resolved = await resolveSessionUser(signedUser);
    if (!resolved) {
      loginLimiter.recordFailure(ip, account);
      return { status: "failed", message: "Invalid credentials." };
    }
    const { user: sessionUser, isReadOnly } = resolved;
    if (isReadOnly) {
      logger.info("HTTP LOGIN success (read-only)", {
        component: "http",
        authenticatedAs: ADMIN_RO_USERNAME,
        effectiveUserId: sessionUser.id,
        ip,
      });
    }

    await issueAuthenticatedSession(req, sessionUser);

    // The store write is what makes the issued cookie mean anything, so it has
    // to land before the response claims the login succeeded. The save made as
    // the response completes comes after the success body is decided, and can
    // only report a failure, not refuse the login.
    await req.session.save();

    // Scoped reset: forgive only the authenticating account's own bucket. The
    // per-IP aggregate keeps its count, so a success here cannot wipe another
    // account's failures from the same IP.
    loginLimiter.reset(ip, account);
    return { status: "success", body: sessionUser };
  }
);
