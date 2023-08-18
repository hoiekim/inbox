import { PushSubscription } from "web-push";
import {
  Route,
  storeSubscription,
  deleteSubscription,
  AUTH_ERROR_MESSAGE
} from "server";

export type SubscribePostResponse = string;

export interface SubscribePostBody {
  old_subscription_id: string;
  subscription: PushSubscription;
}

export const postSubscribeRoute = new Route<SubscribePostResponse>(
  "POST",
  "/subscribe",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const { id: userId } = user;
    const body: SubscribePostBody = req.body;
    const { old_subscription_id, subscription } = body;

    if (old_subscription_id) deleteSubscription(old_subscription_id);
    const { _id: id } = await storeSubscription(userId, subscription);

    return { status: "success", body: id };
  }
);
