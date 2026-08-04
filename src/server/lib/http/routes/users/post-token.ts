import { MailDataToSend } from "common";
import {
  createAuthenticationMail,
  createToken,
  getSignedUser,
  getUser,
  isValidEmail,
  sendMail,
  startTimer
} from "server";
import { READONLY_USERNAME } from "../../../postgres/initialize";
import { Route } from "../route";
import { getClientIp, tokenLimiter } from "../../rate-limit";

export type TokenPostResponse = undefined;

export const postTokenRoute = new Route<TokenPostResponse>(
  "POST",
  "/token",
  async (req) => {
    const ip = getClientIp(req);
    const email = req.body.email as string;

    if (!isValidEmail(email)) {
      tokenLimiter.recordFailure(ip);
      return {
        status: "failed",
        message: "Signup failed because email is invalid."
      };
    }

    // Refuse the reserved read-only identity before createToken runs.
    // createToken hits the "existing user" branch (users.ts:88-91) →
    // usersTable.update(readonly.id, {token, expiry}) AND startTimer
    // (users.ts:105-121) schedules setTimeout(deleteUser, 1h) which
    // hard-DELETEs the readonly row when the expiry passes. Same-shape
    // response as the "invalid email" branch (single-slot rate-limit
    // burn, same success message on the outgoing wire) so an
    // unauthenticated caller can't distinguish the readonly refusal
    // from a normal send.
    const existing = await getUser({ email });
    if (existing?.username === READONLY_USERNAME) {
      tokenLimiter.recordFailure(ip);
      return { status: "success" };
    }

    const [adminUser, createdUser] = await Promise.all([
      getUser({ username: "admin" }),
      createToken(email)
    ]);

    const signedAdminUser = getSignedUser(adminUser);

    if (!signedAdminUser) throw new Error("Admin user does not exist.");
    const { id, username, token } = createdUser;

    const authenticationEamil = createAuthenticationMail(
      email,
      token,
      username
    );

    await sendMail(signedAdminUser, new MailDataToSend(authenticationEamil));

    startTimer(id);

    // Each successful magic-link send consumes one slot in the per-IP quota
    // (the limit exists to prevent mail-sending abuse). Server errors thrown
    // above don't reach this line, so transient 500s no longer burn the quota.
    tokenLimiter.recordFailure(ip);

    return { status: "success" };
  }
);
