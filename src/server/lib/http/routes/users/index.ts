import type { HttpRequest } from "../../request";
import { dispatch, mountedPath } from "../route";
import { getLoginRoute } from "./get-login";
import { postLoginRoute } from "./post-login";
import { deleteLoginRoute } from "./delete-login";
import { postTokenRoute } from "./post-token";
import { postSetInfoRoute } from "./post-set-info";
import { loginLimiter, tokenLimiter, type RateLimiter } from "../../rate-limit";

const routes = [
  getLoginRoute,
  postLoginRoute,
  deleteLoginRoute,
  postTokenRoute,
  postSetInfoRoute
];

// Rate limiters apply only to POST requests (not GET/DELETE).
const postLimiters: [string, RateLimiter][] = [
  [postLoginRoute.path, loginLimiter],
  [postTokenRoute.path, tokenLimiter],
];

/** `/api/users/*`, with `path` relative to that mount. */
const handleUsers = async (req: HttpRequest, path: string): Promise<Response | undefined> => {
  if (req.method === "POST") {
    for (const [prefix, limiter] of postLimiters) {
      const refused = mountedPath(path, prefix) !== undefined ? limiter.check(req) : undefined;
      if (refused) return refused;
    }
  }
  return dispatch(routes, req, path);
};

export default handleUsers;

export * from "./get-login";
export * from "./post-login";
export * from "./delete-login";
export * from "./post-token";
export * from "./post-set-info";
