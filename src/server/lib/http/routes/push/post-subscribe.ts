import { PushSubscription } from "web-push";
import { storeSubscription, AUTH_ERROR_MESSAGE } from "server";
import { Route } from "../route";

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
    const result = await storeSubscription(userId, subscription);

    if (!result) {
      return { status: "failed", message: "Failed to store subscription" };
    }

    return { status: "success", body: result._id };
  }
);
