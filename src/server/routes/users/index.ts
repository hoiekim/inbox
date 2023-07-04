import { Router } from "express";
import { getLoginRoute } from "./get-login";
import { postLoginRoute } from "./post-login";
import { deleteLoginRoute } from "./delete-login";
import { postTokenRoute } from "./post-token";
import { postSetInfoRoute } from "./post-set-info";

const usersRouter = Router();

const routes = [
  getLoginRoute,
  postLoginRoute,
  deleteLoginRoute,
  postTokenRoute,
  postSetInfoRoute
];
routes.forEach((r) => r.register(usersRouter));

export { usersRouter };

export * from "./get-login";
export * from "./post-login";
export * from "./delete-login";
export * from "./post-token";
export * from "./post-set-info";
