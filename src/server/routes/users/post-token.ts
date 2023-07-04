import { Route, sendToken } from "server";

export type TokenPostResponse = undefined;

export const postTokenRoute = new Route<TokenPostResponse>(
  "POST",
  "/token",
  async (req) => {
    const result = await sendToken(req.body.email);
    if (result) return { status: "success" };
    return { status: "failed" };
  }
);
