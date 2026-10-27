import type { HttpRequest } from "../../request";
import { authRequired, dispatch, mountedPath } from "../route";
import { parseUploads, removeTempFiles } from "../../upload";
import { getDomainRoute } from "./get-domain";
import { getAccountsRoute } from "./get-accounts";
import { getHeadersRoute } from "./get-headers";
import { getBodyRoute } from "./get-body";
import { getAttachmentRoute } from "./get-attachment";
import { getSearchRoute } from "./get-search";
import { getSearchAccountsRoute } from "./get-search-accounts";
import { postMarkMailRoute } from "./post-mark";
import { postSendMailRoute } from "./post-send";
import { deleteMailRoute } from "./delete";
import { postMarkSpamMailRoute } from "./post-spam-mark";
import { getSpamAllowlistRoute } from "./get-allowlist";
import { postSpamAllowlistRoute } from "./post-allowlist";
import { deleteSpamAllowlistRoute } from "./delete-allowlist";

const routes = [
  getDomainRoute,
  getAccountsRoute,
  getHeadersRoute,
  getBodyRoute,
  getAttachmentRoute,
  getSearchRoute,
  getSearchAccountsRoute,
  postMarkMailRoute,
  postSendMailRoute,
  deleteMailRoute,
  postMarkSpamMailRoute,
  getSpamAllowlistRoute,
  postSpamAllowlistRoute,
  deleteSpamAllowlistRoute
];

/** `/api/mails/*`, with `path` relative to that mount. */
const handleMails = async (req: HttpRequest, path: string): Promise<Response | undefined> => {
  // All mails routes require authentication, except /domain (public info).
  if (path !== "/domain") {
    const denied = authRequired(req);
    if (denied) return denied;
  }

  // Behind the auth gate above, so an unauthenticated multipart body is never
  // parsed to disk. /send is the only route that reads req.files.
  if (mountedPath(path, "/send") === undefined) return dispatch(routes, req, path);
  const { rejection, tempFiles } = await parseUploads(req, req.raw);
  try {
    return rejection ?? (await dispatch(routes, req, path));
  } finally {
    removeTempFiles(tempFiles);
  }
};

export default handleMails;

export * from "./get-domain";
export * from "./get-accounts";
export * from "./get-headers";
export * from "./get-body";
export * from "./get-attachment";
export * from "./get-search";
export * from "./get-search-accounts";
export * from "./post-mark";
export * from "./post-send";
export * from "./delete";
export * from "./post-spam-mark";
export * from "./get-allowlist";
export * from "./post-allowlist";
export * from "./delete-allowlist";
