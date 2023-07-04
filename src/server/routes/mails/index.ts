import { Router } from "express";
import { getDomainRoute } from "./get-domain";
import { getAccountsRoute } from "./get-accounts";
import { getHeadersRoute } from "./get-headers";
import { getBodyRoute } from "./get-body";
import { getAttachmentRoute } from "./get-attachment";
import { getSearchRoute } from "./get-search";
import { postMarkMailRoute } from "./post-mark";
import { postSendMailRoute } from "./post-send";
import { deleteMailRoute } from "./delete";

const mailsRouter = Router();

const routes = [
  getDomainRoute,
  getAccountsRoute,
  getHeadersRoute,
  getBodyRoute,
  getAttachmentRoute,
  getSearchRoute,
  postMarkMailRoute,
  postSendMailRoute,
  deleteMailRoute
];
routes.forEach((r) => r.register(mailsRouter));

export { mailsRouter };

export * from "./get-domain";
export * from "./get-accounts";
export * from "./get-headers";
export * from "./get-body";
export * from "./get-attachment";
export * from "./get-search";
export * from "./post-mark";
export * from "./post-send";
export * from "./delete";
