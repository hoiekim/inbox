import { push } from "server";
import { Route } from "../route";

export type SubscribeDeleteResponse = undefined;

// Authenticated + user-scoped: removes only the caller's own subscription row
// (the :id is the per-subscription UUID minted by /subscribe, so scoping the
// delete to the session user stops one user deleting another's by id).
export const deleteSubscribeRoute = new Route<SubscribeDeleteResponse>(
  "DELETE",
  "/subscribe/:id",
  async (req) => {
    const { id: userId } = req.session.user!;
    const deleted = await push.deleteSubscriptionForUser(req.params.id, userId);
    if (deleted) return { status: "success" };
    return { status: "failed", message: "No subscription found" };
  }
);
