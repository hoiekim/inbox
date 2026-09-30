import express from "express";

import { isProduction } from "../env";

/**
 * Constructs the express app with every setting that has to be resolved from
 * the *runtime* environment.
 */
export const createExpressApp = (): express.Application => {
  const app = express();

  app.set("env", isProduction() ? "production" : "development");

  // Trust the proxy by ADDRESS, not by hop count. A hop count trusts whichever
  // peer opened the connection, so a request that reaches the app port without
  // passing the proxy could still name its own `req.ip` through a forwarding
  // header. With an address list, such a peer is untrusted and `req.ip` stays
  // its real socket address.
  if (isProduction()) {
    app.set("trust proxy", ["loopback", "uniquelocal"]);
  }

  return app;
};
