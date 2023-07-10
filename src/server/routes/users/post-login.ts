import bcrypt from "bcrypt";
import { Route, MaskedUser, getUser, User, maskUser } from "server";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    const inputUser = req.body as User;

    const user = await getUser(inputUser);
    if (!user) {
      return { status: "failed", message: "Invalid credentials." };
    }

    const pwMatches = await bcrypt.compare(inputUser.password, user.password);
    if (!pwMatches) {
      return { status: "failed", message: "Invalid credentials." };
    }

    const maskedUser = maskUser(user);
    req.session.user = maskedUser;

    return { status: "success", body: maskedUser };
  }
);
