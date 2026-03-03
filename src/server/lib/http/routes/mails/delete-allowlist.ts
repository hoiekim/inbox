import { AUTH_ERROR_MESSAGE } from "server";
import { removeAllowlistEntry } from "../../../postgres/repositories/spamAllowlist";
import { Route } from "../route";

export type AllowlistDeleteResponse = undefined;

/**
 * Remove an entry from the user's spam allowlist.
 */
export const deleteAllowlistRoute = new Route<AllowlistDeleteResponse>(
  "DELETE",
  "/allowlist/:pattern",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const pattern = decodeURIComponent(req.params.pattern);
    const removed = await removeAllowlistEntry(user.id, pattern);

    if (!removed) {
      return { status: "failed", message: "Entry not found" };
    }

    return { status: "success" };
  }
);
