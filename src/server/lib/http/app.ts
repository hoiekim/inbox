import express from "express";

import { isProduction } from "../env";

/**
 * Constructs the express app with every setting that has to be resolved from
 * the *runtime* environment.
 */
export const createExpressApp = (): express.Application => {
  const app = express();

  app.set("env", isProduction() ? "production" : "development");

  // Trust first proxy for secure cookie detection behind reverse proxy.
  // (Rate limiting reads X-Real-IP directly and does not rely on req.ip.)
  if (isProduction()) {
    app.set("trust proxy", 1);
  }

  return app;
};
