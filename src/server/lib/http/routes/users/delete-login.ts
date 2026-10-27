import { Route } from "../route";

export type LoginDeleteResponse = undefined;

export const deleteLoginRoute = new Route<LoginDeleteResponse>(
  "DELETE",
  "/login",
  async (req) => {
    await req.session.destroy();
    return { status: "success" };
  }
);
