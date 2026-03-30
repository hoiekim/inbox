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

const apiRouter = Router();

apiRouter.use((req, _res, next) => {
  // Skip logging for health check requests (e.g. from reverse proxy)
  if (req.url === "/health") {
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

apiRouter.use("/health", healthRouter);
apiRouter.use("/client-error", clientErrorRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/mails", mailsRouter);
apiRouter.use("/push", pushRouter);

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
