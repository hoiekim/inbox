import { Route, getPushPublicKey } from "server";

export type PublicKeyGetResponse = string;

export const getPublicKeyRoute = new Route<PublicKeyGetResponse>(
  "GET",
  "/public-key",
  async () => {
    return { status: "success", body: getPushPublicKey() };
  }
);
