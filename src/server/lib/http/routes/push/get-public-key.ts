import { getPushPublicKey } from "server";
import { Route } from "../route";

export type PublicKeyGetResponse = string;

export const getPublicKeyRoute = new Route<PublicKeyGetResponse>(
  "GET",
  "/public-key",
  async () => {
    return { status: "success", body: getPushPublicKey() };
  }
);
