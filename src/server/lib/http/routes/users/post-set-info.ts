import { MaskedUser } from "common";
import { setUserInfo } from "server";
import { READONLY_USERNAME } from "../../../postgres/initialize";
import { Route } from "../route";

export type SetInfoPostResponse = MaskedUser;

export const postSetInfoRoute = new Route<SetInfoPostResponse>(
  "POST",
  "/set-info",
  async (req) => {
    // Validate body shape before passing to setUserInfo.
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "failed", message: "Invalid request body." };
    }

    const { email, username, password, token } = body as Record<string, unknown>;

    if (typeof email !== "string" || !email) {
      return { status: "failed", message: "email is required and must be a string." };
    }
    if (typeof username !== "string" || !username) {
      return { status: "failed", message: "username is required and must be a string." };
    }
    if (typeof password !== "string" || !password) {
      return { status: "failed", message: "password is required and must be a string." };
    }
    if (token !== undefined && typeof token !== "string") {
      return { status: "failed", message: "token must be a string." };
    }

    const user = await setUserInfo({ email, username, password, token: token as string | undefined });

    // Same identity-boundary guard as post-login.ts. `setUserInfo` falls
    // into the else-branch of lib/users.ts when a user already exists, so
    // the input `username` is ignored and the persisted `readonly` name
    // reaches this response. Refusing session issuance here — the only
    // other `req.session.user = …` site in the codebase — closes the
    // second door on the read-only identity's HTTP surface.
    if (user?.username === READONLY_USERNAME) {
      return { status: "failed", message: "Invalid credentials." };
    }

    req.session.user = user;
    return { status: "success", body: user };
  }
);
