import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getLoginRoute } from "./get-login";
import { postLoginRoute } from "./post-login";
import { deleteLoginRoute } from "./delete-login";
import { postTokenRoute } from "./post-token";
import { postSetInfoRoute } from "./post-set-info";

const usersRouter = Router();

// Rate limiter for login endpoint: 5 attempts per 15 minutes per IP
// skipSuccessfulRequests allows legitimate users to continue after successful login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  message: { status: "failed", message: "Too many login attempts, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

// Rate limiter for token endpoint: 3 requests per 15 minutes per IP
// Stricter limit to prevent email bombing attacks
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 3,
  message: { status: "failed", message: "Too many token requests, try again later" },
  standardHeaders: true,
  legacyHeaders: false
});

// Apply rate limiters using route paths (avoids hardcoded strings)
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
