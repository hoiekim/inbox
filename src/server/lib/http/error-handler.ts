import type { ErrorRequestHandler } from "express";
import { STATUS_CODES } from "http";

import { logger } from "../logger";
import { sendAlarm } from "../alarm";

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

const DETAIL = "Internal server error";

/**
 * The 4xx an upstream middleware asked for, by express's `err.status`
 * convention — `body-parser` raises 400 on a malformed body and 413 over the
 * size limit. Anything else, including a 5xx, is a fault of ours.
 */
const clientErrorStatus = (error: unknown): number | undefined => {
  const { status, statusCode } = (error ?? {}) as Record<string, unknown>;
  const value = typeof status === "number" ? status : statusCode;
  return typeof value === "number" && value >= 400 && value < 500 ? value : undefined;
};

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
  const clientStatus = clientErrorStatus(error);

  // A malformed body is reachable unauthenticated, and every alarm here shares
  // one cooldown key — so alarming on a client error would let anyone suppress
  // the store-fault alarm this handler exists to raise.
  if (clientStatus === undefined) {
    logger.error(
      "Unhandled middleware error",
      { method: req.method, path: req.path, session_id: req.sessionID },
      error
    );
    sendAlarm(
      "Unhandled Middleware Error",
      `**Request:** ${req.method} ${req.path}\n**Error:** ${message}`
    ).catch(() => undefined);
  }

  // express-session defers `next(err)` on a write fault until after it has
  // called `res.end()`, and finalhandler answers a headers-sent error by
  // destroying the socket — which drops whatever tail of the body is still
  // queued, truncating an otherwise complete 200.
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  // The driver message stays server-side, matching the router's own terminal
  // handler. A store fault's text names table and column, and the deployment
  // sets no NODE_ENV, so an environment-gated body would disclose it by default.
  const status = clientStatus ?? 500;
  const detail = clientStatus === undefined ? DETAIL : (STATUS_CODES[clientStatus] ?? DETAIL);

  if (isApiPath(req.path)) {
    res.status(status).json({ status: "error", message: detail });
    return;
  }
  res.status(status).type("text/plain").send(detail);
};
