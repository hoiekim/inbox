import { PushSubscription } from "web-push";
import { push } from "server";
import { Route } from "../route";

export type SubscribePostResponse = string;

export interface SubscribePostBody {
  subscription: PushSubscription;
}

export const postSubscribeRoute = new Route<SubscribePostResponse>(
  "POST",
  "/subscribe",
  async (req) => {
    const user = req.session.user!;

    const { id: userId } = user;
    const body: SubscribePostBody = req.body;
    const { subscription } = body;
    const result = await push.storeSubscription(userId, subscription);

    if (!result) {
      return { status: "failed", message: "Failed to store subscription" };
    }

    return { status: "success", body: result._id };
  }
);
