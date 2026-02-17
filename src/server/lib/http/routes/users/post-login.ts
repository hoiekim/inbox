import bcrypt from "bcryptjs";
import { MaskedUser, User } from "common";
import { getUser } from "server";
import { Route } from "../route";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    const inputUser = req.body as User;

    const user = await getUser(inputUser);
    const signedUser = user?.getSigned();
    if (!inputUser.password || !user || !signedUser) {
      return { status: "failed", message: "Invalid credentials." };
    }

    const pwMatches = await bcrypt.compare(
      inputUser.password,
      user.password as string
    );

    if (!pwMatches) {
      return { status: "failed", message: "Invalid credentials." };
    }

    req.session.user = signedUser;

    return { status: "success", body: signedUser };
  }
);
