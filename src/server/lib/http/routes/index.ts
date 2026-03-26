import { Router } from "express";

export * from "./route";

import usersRouter from "./users";
import mailsRouter from "./mails";
import pushRouter from "./push";
import healthRouter from "./health";

const apiRouter = Router();

apiRouter.use((req, _res, next) => {
  // Skip logging for health check requests (e.g. from reverse proxy)
  if (req.url === "/health") {
    next();
    return;
  }

  console.info(`<${req.method}> /api${req.url}`);
  console.group();
  const date = new Date();
  const offset = date.getTimezoneOffset() / -60;
  const offsetString = (offset > 0 ? "+" : "") + offset + "H";
  console.info(`at: ${date.toLocaleString()}, ${offsetString}`);
  console.info(`ip: ${req.ip}`);
  console.info(`x-forwarded-for: ${req.headers["x-forwarded-for"] ?? "(none)"}`);
  console.info(`x-real-ip: ${req.headers["x-real-ip"] ?? "(none)"}`);
  console.groupEnd();
  next();
});

apiRouter.use("/health", healthRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/mails", mailsRouter);
apiRouter.use("/push", pushRouter);

export default apiRouter;

export * from "./users";
export * from "./mails";
export * from "./push";
