import { PushSubscription } from "web-push";
import { push } from "server";
import { Route } from "../route";
import { validatePushSubscription } from "../../../push-validation";

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
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "failed", message: "Invalid request body." };
    }

    const { subscription } = body as Record<string, unknown>;
    const validation = validatePushSubscription(subscription);

    if (!validation.valid) {
      return { status: "failed", message: validation.message };
    }

    const result = await push.storeSubscription(userId, validation.subscription);

    if (!result) {
      return { status: "failed", message: "Failed to store subscription" };
    }

    return { status: "success", body: result._id };
  }
);
