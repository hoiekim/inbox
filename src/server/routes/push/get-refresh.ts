import { Route, refreshSubscription } from "server";

export type RefreshGetResponse = undefined;

export const getRefreshRoute = new Route<RefreshGetResponse>(
  "GET",
  "/refresh/:id",
  async (req) => {
    await refreshSubscription(req.params.id);
    return { status: "success" };
  }
);
