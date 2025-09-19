import { getDomain } from "server";
import { Route } from "../route";

export type DomainGetResponse = string;

export const getDomainRoute = new Route<DomainGetResponse>(
  "GET",
  "/domain",
  async () => ({ status: "success", body: getDomain() })
);
