import { Router } from "express";
import { authRequired } from "../route";
import { getDomainRoute } from "./get-domain";
import { getAccountsRoute } from "./get-accounts";
import { getHeadersRoute } from "./get-headers";
import { getBodyRoute } from "./get-body";
import { getAttachmentRoute } from "./get-attachment";
import { getSearchRoute } from "./get-search";
import { postMarkMailRoute } from "./post-mark";
import { postSendMailRoute } from "./post-send";
import { deleteMailRoute } from "./delete";
import { getSpamMailsRoute } from "./get-spam";
import { postMarkSpamMailRoute } from "./post-spam-mark";
import { getSpamAllowlistRoute } from "./get-allowlist";
import { postSpamAllowlistRoute } from "./post-allowlist";
import { deleteSpamAllowlistRoute } from "./delete-allowlist";

const mailsRouter = Router();

// All mails routes require authentication, except /domain (public info).
mailsRouter.use((req, res, next) => {
  if (req.path === "/domain") return next();
  return authRequired(req, res, next);
});

const routes = [
  getDomainRoute,
  getAccountsRoute,
  getHeadersRoute,
  getBodyRoute,
  getAttachmentRoute,
  getSearchRoute,
  postMarkMailRoute,
  postSendMailRoute,
  deleteMailRoute,
  getSpamMailsRoute,
  postMarkSpamMailRoute,
  getSpamAllowlistRoute,
  postSpamAllowlistRoute,
  deleteSpamAllowlistRoute
];

routes.forEach((r) => r.register(mailsRouter));

export default mailsRouter;

export * from "./get-domain";
export * from "./get-accounts";
export * from "./get-headers";
export * from "./get-body";
export * from "./get-attachment";
export * from "./get-search";
export * from "./post-mark";
export * from "./post-send";
export * from "./delete";
export * from "./get-spam";
export * from "./post-spam-mark";
export * from "./get-allowlist";
export * from "./post-allowlist";
export * from "./delete-allowlist";
