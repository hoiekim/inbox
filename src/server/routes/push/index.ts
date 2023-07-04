import { Router } from "express";
import { getPublicKeyRoute } from "./get-public-key";
import { getRefreshRoute } from "./get-refresh";
import { postSubscribeRoute } from "./post-subscribe";

const pushRouter = Router();

const routes = [getPublicKeyRoute, getRefreshRoute, postSubscribeRoute];

routes.forEach((r) => r.register(pushRouter));

export default pushRouter;

export * from "./get-public-key";
export * from "./get-refresh";
export * from "./post-subscribe";
