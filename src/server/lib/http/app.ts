import express from "express";

import { isProduction } from "../env";

/**
 * Constructs the express app with every setting that has to be resolved from
 * the *runtime* environment.
 *
 * Express seeds `env` itself from the member expression Bun constant-folds, so
 * in the shipped bundle it is frozen at whatever the build saw and no container
 * environment can move it. finalhandler reads `env` to decide whether an
 * unhandled error's stack goes into the response body — with it stuck at
 * "development", an unauthenticated malformed-JSON POST answers with a full
 * stack trace and absolute bundle paths.
 *
 * The app is built here rather than settings being applied to a caller's app so
 * the two cannot drift: there is no express() in this codebase that skipped
 * them.
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
