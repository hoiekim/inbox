import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../../logger";

export * from "./route";

import usersRouter from "./users";
import mailsRouter from "./mails";
import pushRouter from "./push";
import healthRouter from "./health";
import clientErrorRouter from "./client-error";
import { getClientIp } from "server";
import { sendAlarm } from "../../alarm";
import { createLimiter } from "../rate-limit";
import { postMailgunEventsRoute } from "./mailgun-events";

const apiRouter = Router();

apiRouter.use((req, _res, next) => {
  // Skip logging for the infra health check and the client liveness ping —
  // both are polled frequently (reverse proxy / every open tab's 30s offline
  // heartbeat) and would otherwise flood the request log.
  if (req.url === "/health" || req.url === "/ping") {
    next();
    return;
  }

  const date = new Date();
  const offset = date.getTimezoneOffset() / -60;
  const offsetString = (offset > 0 ? "+" : "") + offset + "H";
  logger.info(`<${req.method}> /api${req.url}`, {
    at: `${date.toLocaleString()}, ${offsetString}`,
    from: getClientIp(req),
  });
  next();
});

// Cheap liveness probe for the client's offline heartbeat: just "is the HTTP
// server reachable", with none of /health's DB query + SMTP/IMAP socket probes
// (which would multiply into N port-scans per 30s at N users with open tabs).
apiRouter.get("/ping", (_req, res) => {
  res.json({ status: "success" });
});

apiRouter.use("/health", healthRouter);
apiRouter.use("/client-error", clientErrorRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/mails", mailsRouter);
apiRouter.use("/push", pushRouter);

// Mailgun events webhook — public (HMAC-signed by Mailgun, verified in the
// route handler). Mounted at the /api root so the path Mailgun POSTs to is
// exactly `/api/mailgun-events`. Rate-limited per IP to keep an attacker
// from burning the alarm-cooldown bucket via replayed captured signatures.
const mailgunEventsLimiter = createLimiter(
  60,
  "Too many Mailgun webhook requests, try again later",
);
apiRouter.use("/mailgun-events", mailgunEventsLimiter.middleware);
postMailgunEventsRoute.register(apiRouter);

// Unmatched /api/* requests get a JSON 404 rather than falling through to the
// SPA index.html catch-all in http/index.ts. Without this, an authenticated
// GET to e.g. /api/mails/unknown-route returns 200 + text/html, which silently
// breaks any client that parses the body as JSON.
apiRouter.use((_req, res) => {
  if (res.headersSent) return;
  res.status(404).json({ status: "failed", message: "Not found" });
});

// Global 5xx error handler — catches unhandled errors thrown inside route handlers
// eslint-disable-next-line @typescript-eslint/no-unused-vars
apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  console.error("Unhandled route error:", message);
  sendAlarm(
    "Unhandled Route Error",
    `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``,
  ).catch(() => undefined);
  if (!res.headersSent) {
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

export default apiRouter;

export * from "./users";
export * from "./mails";
export * from "./push";
export * from "./mailgun-events";
