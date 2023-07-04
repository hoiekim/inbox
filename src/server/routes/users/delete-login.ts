import { Route } from "server";

export type LoginDeleteResponse = undefined;

export const deleteLoginRoute = new Route<LoginDeleteResponse>(
  "DELETE",
  "/login",
  async (req) => {
    req.session.destroy((error) => {
      if (error) {
        console.error(error);
        throw new Error("Failed to destroy session.");
      }
    });
    return { status: "success" };
  }
);
