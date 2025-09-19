import { SignedUser } from "common";
import { version } from "server";
import { Route } from "../route";

export interface LoginGetResponse {
  user?: SignedUser;
  app: { version: string };
}

export const getLoginRoute = new Route<LoginGetResponse>(
  "GET",
  "/login",
  async (req) => {
    const { user } = req.session;
    return {
      status: "success",
      body: { user, app: { version } },
      message: user ? undefined : "Not logged in."
    };
  }
);
