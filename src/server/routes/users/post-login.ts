import bcrypt from "bcrypt";
import {
  Route,
  MaskedUser,
  getUser,
  User,
  maskUser,
  getSignedUser
} from "server";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    const inputUser = req.body as User;

    const user = await getUser(inputUser);
    const signedUser = getSignedUser(user);
    if (!inputUser.password || !user || !signedUser) {
      return { status: "failed", message: "Invalid credentials." };
    }

    const pwMatches = await bcrypt.compare(
      inputUser.password,
      signedUser.password
    );

    if (!pwMatches) {
      return { status: "failed", message: "Invalid credentials." };
    }

    const maskedUser = maskUser(signedUser);
    req.session.user = maskedUser;

    return { status: "success", body: maskedUser };
  }
);
