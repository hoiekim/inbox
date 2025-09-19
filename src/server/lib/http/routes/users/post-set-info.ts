import { MaskedUser } from "common";
import { setUserInfo } from "server";
import { Route } from "../route";

export type SetInfoPostResponse = MaskedUser;

export const postSetInfoRoute = new Route<SetInfoPostResponse>(
  "POST",
  "/set-info",
  async (req) => {
    const user = await setUserInfo(req.body);
    req.session.user = user;
    return { status: "success", body: user };
  }
);
