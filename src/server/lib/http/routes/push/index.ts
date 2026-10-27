import type { HttpRequest } from "../../request";
import { authRequired, dispatch } from "../route";
import { deleteSubscribeRoute } from "./delete-subscribe";
import { getPublicKeyRoute } from "./get-public-key";
import { getRefreshRoute } from "./get-refresh";
import { postSubscribeRoute } from "./post-subscribe";

const routes = [
  getPublicKeyRoute,
  getRefreshRoute,
  postSubscribeRoute,
  deleteSubscribeRoute,
];

/** `/api/push/*`, with `path` relative to that mount. */
const handlePush = async (req: HttpRequest, path: string): Promise<Response | undefined> => {
  // /public-key and /refresh/:id are intentionally unauthenticated.
  // /public-key returns the VAPID public key needed before subscription.
  // /refresh/:id is called by a service worker using a stored subscription ID.
  // Everything else (/subscribe) requires a logged-in session.
  if (path !== "/public-key" && !path.startsWith("/refresh")) {
    const denied = authRequired(req);
    if (denied) return denied;
  }
  return dispatch(routes, req, path);
};

export default handlePush;

export * from "./delete-subscribe";
export * from "./get-public-key";
export * from "./get-refresh";
export * from "./post-subscribe";
