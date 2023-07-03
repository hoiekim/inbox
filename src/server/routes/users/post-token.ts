import { Route, sendToken } from "server";

export const postTokenRoute = new Route("POST", "/token", async (req) => {
  const result = await sendToken(req.body.email);
  if (result) return { status: "success" };
  return { status: "failed" };
});
