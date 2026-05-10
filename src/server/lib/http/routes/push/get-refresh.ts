import { push } from "server";
import { Route } from "../route";

export type RefreshGetResponse = undefined;

export const getRefreshRoute = new Route<RefreshGetResponse>(
  "GET",
  "/refresh/:id",
  async (req) => {
    const result = await push.refreshSubscription(req.params.id);
    if (result) {
      return { status: "success" };
    } else {
      return { status: "failed", message: "No subscription found" };
    }
  }
);
