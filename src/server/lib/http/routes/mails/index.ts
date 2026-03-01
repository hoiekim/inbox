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
import { getSpamRoute } from "./get-spam";
import { postSpamMarkRoute } from "./post-spam-mark";
import {
  getAllowlistRoute,
  postAllowlistRoute,
  deleteAllowlistRoute
} from "./allowlist";

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
  deleteMailRoute,
  getSpamRoute,
  postSpamMarkRoute,
  getAllowlistRoute,
  postAllowlistRoute,
  deleteAllowlistRoute
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
export * from "./allowlist";
