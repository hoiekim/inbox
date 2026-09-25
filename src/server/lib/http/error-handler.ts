import type { ErrorRequestHandler } from "express";

import { logger } from "../logger";
import { isProduction } from "../env";
import { sendAlarm } from "../alarm";

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

/**
 * Terminal error handler for the application stack. Register it last, after
 * every route.
 *
 * `apiRouter`'s own error handler only sees errors raised inside `/api`
 * handlers; middleware mounted ahead of it — `express-session`, which forwards
 * every store `get` and `set` fault through `next(err)` — is upstream of that
 * router, so without this the faults land in express's `finalhandler` with no
 * structured log and no alarm.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const message = error instanceof Error ? error.message : String(error);

  logger.error(
    "Unhandled middleware error",
    { method: req.method, path: req.path, session_id: req.sessionID },
    error
  );
  sendAlarm(
    "Unhandled Middleware Error",
    `**Request:** ${req.method} ${req.path}\n**Error:** ${message}`
  ).catch(() => undefined);

  // express-session defers `next(err)` on a write fault until after it has
  // called `res.end()`, and finalhandler answers a headers-sent error by
  // destroying the socket — which drops whatever tail of the body is still
  // queued, truncating an otherwise complete 200.
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  const detail = isProduction() ? "Internal server error" : message;
  if (isApiPath(req.path)) {
    res.status(500).json({ status: "error", message: detail });
    return;
  }
  res.status(500).type("text/plain").send(detail);
};
