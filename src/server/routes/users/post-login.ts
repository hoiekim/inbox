import { Route, MaskedUser, signIn } from "server";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    const maskedUser = await signIn(req.body);
    if (maskedUser) {
      req.session.user = maskedUser;
      return { status: "success", body: maskedUser };
    } else {
      return { status: "failed", message: "User is not found." };
    }
  }
);
