import { Router } from "express";
import { authRequired } from "../route";
import { getPublicKeyRoute } from "./get-public-key";
import { getRefreshRoute } from "./get-refresh";
import { postSubscribeRoute } from "./post-subscribe";

const pushRouter = Router();

// /public-key and /refresh/:id are intentionally unauthenticated.
// /public-key returns the VAPID public key needed before subscription.
// /refresh/:id is called by a service worker using a stored subscription ID.
// Everything else (/subscribe) requires a logged-in session.
pushRouter.use((req, res, next) => {
  if (req.path === "/public-key" || req.path.startsWith("/refresh")) return next();
  return authRequired(req, res, next);
});

const routes = [getPublicKeyRoute, getRefreshRoute, postSubscribeRoute];

routes.forEach((r) => r.register(pushRouter));

export default pushRouter;

export * from "./get-public-key";
export * from "./get-refresh";
export * from "./post-subscribe";
