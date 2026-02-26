import { Request, Response, NextFunction, Router } from "express";
import { getLoginRoute } from "./get-login";
import { postLoginRoute } from "./post-login";
import { deleteLoginRoute } from "./delete-login";
import { postTokenRoute } from "./post-token";
import { postSetInfoRoute } from "./post-set-info";

const usersRouter = Router();

// Simple in-memory rate limiters
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const attempts = new Map<string, { count: number; resetAt: number }>();

const createLimiter = (maxAttempts: number, message: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const record = attempts.get(ip);

    if (record && now < record.resetAt) {
      if (record.count >= maxAttempts) {
        res.status(429).json({ status: "failed", message });
        return;
      }
      record.count++;
    } else {
      attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    }

    next();
  };
};

// 5 attempts per 15 minutes for login
const loginLimiter = createLimiter(5, "Too many login attempts, try again later");

// 3 attempts per 15 minutes for token requests (stricter to prevent email bombing)
const tokenLimiter = createLimiter(3, "Too many token requests, try again later");

// Apply rate limiters using route paths
usersRouter.use(postLoginRoute.path, loginLimiter);
usersRouter.use(postTokenRoute.path, tokenLimiter);

const routes = [
  getLoginRoute,
  postLoginRoute,
  deleteLoginRoute,
  postTokenRoute,
  postSetInfoRoute
];

routes.forEach((r) => r.register(usersRouter));

export default usersRouter;

export * from "./get-login";
export * from "./post-login";
export * from "./delete-login";
export * from "./post-token";
export * from "./post-set-info";
