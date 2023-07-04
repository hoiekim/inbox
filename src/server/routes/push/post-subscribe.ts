import { PushSubscription } from "web-push";
import { Route, storeSubscription, deleteSubscription } from "server";

export type SubscribePostResponse = string;

export interface SubscribePostBody {
  old_subscription_id: string;
  subscription: PushSubscription;
}

export const postSubscribeRoute = new Route<SubscribePostResponse>(
  "POST",
  "/subscribe",
  async (req) => {
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const { username } = req.session.user;
    const body: SubscribePostBody = req.body;
    const { old_subscription_id, subscription } = body;

    if (old_subscription_id) deleteSubscription(old_subscription_id);
    const { _id: id } = await storeSubscription(username, subscription);

    return { status: "success", body: id };
  }
);
