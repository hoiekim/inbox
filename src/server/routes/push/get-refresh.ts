import { Route, refreshSubscription } from "server";

export type RefreshGetResponse = undefined;

export const getRefreshRoute = new Route<RefreshGetResponse>(
  "GET",
  "/refresh/:id",
  async (req) => {
    const result = await refreshSubscription(req.params.id);
    if (result.updated) {
      return { status: "success" };
    } else {
      return { status: "failed", message: "No subscription found" };
    }
  }
);
