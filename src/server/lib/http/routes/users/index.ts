import { Router, Request, Response, NextFunction } from "express";
import { getLoginRoute } from "./get-login";
import { postLoginRoute } from "./post-login";
import { deleteLoginRoute } from "./delete-login";
import { postTokenRoute } from "./post-token";
import { postSetInfoRoute } from "./post-set-info";
import { loginLimiter, tokenLimiter } from "../../rate-limit";

const usersRouter = Router();

// Helper to apply limiter only to POST requests
const postOnly =
  (limiter: (req: Request, res: Response, next: NextFunction) => void) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST") {
      return limiter(req, res, next);
    }
    next();
  };

// Apply rate limiters only to POST requests (not GET/DELETE)
usersRouter.use(postLoginRoute.path, postOnly(loginLimiter));
usersRouter.use(postTokenRoute.path, postOnly(tokenLimiter));

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
