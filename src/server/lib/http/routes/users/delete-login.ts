import { Route } from "../route";
import { logger } from "../../../logger";

export type LoginDeleteResponse = undefined;

export const deleteLoginRoute = new Route<LoginDeleteResponse>(
  "DELETE",
  "/login",
  async (req) => {
    req.session.destroy((error) => {
      if (error) {
        logger.error("Failed to destroy session", {}, error);
        throw new Error("Failed to destroy session.");
      }
    });
    return { status: "success" };
  }
);
