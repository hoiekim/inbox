import { PushSubscription } from "web-push";
import { Route, storeSubscription, AUTH_ERROR_MESSAGE } from "server";

export type SubscribePostResponse = string;

export interface SubscribePostBody {
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
    const { subscription } = body;
    const { _id: id } = await storeSubscription(userId, subscription);

    return { status: "success", body: id };
  }
);
