import { push } from "server";
import { Route } from "../route";

export type SubscribeDeleteResponse = undefined;

// Removes the server-side push_subscription row so a logout-without-relogin
// doesn't leave it orphaned (the browser-side subscription is dropped by the
// SW teardown at the same logout site). Authenticated — the session is still
// live during logout teardown — and the :id is the unguessable per-subscription
// UUID minted by /subscribe, matching /refresh/:id's capability model.
export const deleteSubscribeRoute = new Route<SubscribeDeleteResponse>(
  "DELETE",
  "/subscribe/:id",
  async (req) => {
    const deleted = await push.deleteSubscription(req.params.id);
    if (deleted) return { status: "success" };
    return { status: "failed", message: "No subscription found" };
  }
);
