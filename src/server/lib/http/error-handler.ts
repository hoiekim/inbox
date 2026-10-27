import { STATUS_CODES } from "http";

import { logger } from "../logger";
import { sendAlarm } from "../alarm";
import type { HttpRequest } from "./request";
import { json, text } from "./respond";

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

const DETAIL = "Internal server error";

/**
 * The 4xx a body parser or route matcher asked for through `err.status` — 400
 * on a malformed body, 413 over the size limit. Anything else, including a
 * 5xx, is a fault of ours.
 */
const clientErrorStatus = (error: unknown): number | undefined => {
  const { status, statusCode } = (error ?? {}) as Record<string, unknown>;
  const value = typeof status === "number" ? status : statusCode;
  return typeof value === "number" && value >= 400 && value < 500 ? value : undefined;
};

/** What the error handler needs to know about the request that failed. */
type FailedRequest = Pick<HttpRequest, "method" | "path"> & { sessionId?: string };

/**
 * Logs and alarms on a fault raised outside any route — a session store read
 * or write, a static file read. A client error is not reported: a malformed
 * body is reachable unauthenticated, and every alarm here shares one cooldown
 * key, so alarming on one would let anyone suppress the store-fault alarm this
 * exists to raise.
 */
export const reportMiddlewareError = (error: unknown, req: FailedRequest) => {
  if (clientErrorStatus(error) !== undefined) return;
  const message = error instanceof Error ? error.message : String(error);
  logger.error(
    "Unhandled middleware error",
    { method: req.method, path: req.path, session_id: req.sessionId },
    error
  );
  sendAlarm(
    "Unhandled Middleware Error",
    `**Request:** ${req.method} ${req.path}\n**Error:** ${message}`
  ).catch(() => undefined);
};

/**
 * Terminal error handler for the application: reports the fault (see
 * {@link reportMiddlewareError}) and answers it. A client error keeps its 4xx;
 * anything else is a 500 whose body never carries the error's text.
 */
export const errorHandler = (error: unknown, req: FailedRequest): Response => {
  reportMiddlewareError(error, req);

  // The driver message stays server-side, matching the router's own terminal
  // handler. A store fault's text names table and column, and the deployment
  // sets no NODE_ENV, so an environment-gated body would disclose it by default.
  const clientStatus = clientErrorStatus(error);
  const status = clientStatus ?? 500;
  const detail = clientStatus === undefined ? DETAIL : (STATUS_CODES[clientStatus] ?? DETAIL);

  if (isApiPath(req.path)) return json({ status: "error", message: detail }, status);
  return text(detail, status);
};
