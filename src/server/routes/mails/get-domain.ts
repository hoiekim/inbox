import { Route, getDomain } from "server";

export type DomainGetResponse = string;

export const getDomainRoute = new Route<DomainGetResponse>(
  "GET",
  "/domain",
  async () => ({ status: "success", body: getDomain() })
);
