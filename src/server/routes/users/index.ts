import { Router } from "express";
import { getLoginRoute } from "./get-login";

export const usersRouter = Router();

getLoginRoute.register(usersRouter);
