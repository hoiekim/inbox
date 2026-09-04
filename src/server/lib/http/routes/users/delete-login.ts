import { Route } from "../route";

export type LoginDeleteResponse = undefined;

export const deleteLoginRoute = new Route<LoginDeleteResponse>(
  "DELETE",
  "/login",
  async (req) => {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((error) => (error ? reject(error) : resolve()));
    });
    return { status: "success" };
  }
);
