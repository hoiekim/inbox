import bcrypt from "bcryptjs";
import { MaskedUser } from "common";
import { getUser } from "server";
import { READONLY_USERNAME } from "../../../postgres/initialize";
import { Route } from "../route";
import { getClientIp, loginLimiter } from "../../rate-limit";

export type LoginPostResponse = MaskedUser;

// Valid bcrypt hash used as a constant-time dummy to prevent timing-based
// username enumeration. bcrypt.compare still runs its full cost-10 work
// when the user is not found, so response time is indistinguishable.
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

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

    // Always run bcrypt.compare regardless of whether the user exists.
    // This prevents timing attacks that could reveal valid usernames.
    const pwMatches = user
      ? await bcrypt.compare(password, user.password as string)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    const ip = getClientIp(req);

    if (!pwMatches || !signedUser) {
      loginLimiter.recordFailure(ip);
      return { status: "failed", message: "Invalid credentials." };
    }

    // Read-only user is IMAP-only. Refusing the HTTP session here — rather
    // than trying to gate each mutating HTTP route — is what makes the
    // "readonly = no mail-state mutation" guarantee hold at the identity
    // boundary. Same-shape error as bad credentials so a caller with the
    // readonly credential can't distinguish "wrong password" from "wrong
    // surface" (no signal to probe).
    if (signedUser.username === READONLY_USERNAME) {
      loginLimiter.recordFailure(ip);
      return { status: "failed", message: "Invalid credentials." };
    }

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    req.session.user = signedUser;

    loginLimiter.reset(ip);
    return { status: "success", body: signedUser };
  }
);
