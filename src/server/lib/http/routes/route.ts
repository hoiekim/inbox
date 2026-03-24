import { Router, RequestHandler, Request, Response } from "express";
import { logger } from "../../logger";
import { sendAlarm } from "../../alarm";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}

export class StreamingStatus {
  counter = 0;
  limit = 1;

  constructor(limit?: number) {
    if (limit) this.limit = limit;
  }

  get = (): ApiResponse["status"] => {
    this.counter++;
    if (this.counter >= this.limit) return "success";
    return "streaming";
  };
}

export type Stream<T = undefined> = (
  response: T extends Buffer ? Buffer : ApiResponse<T>
) => void;

export type GetResponse<T = unknown> = (
  req: Request,
  res: Response,
  stream: Stream<T>
) => Promise<T extends Buffer ? Buffer | ApiResponse : ApiResponse<T> | void>;

export class Route<T> {
  method: Method;
  path: string;
  callback: GetResponse<T>;

  constructor(method: Method, path: string, callback: GetResponse<T>) {
    this.method = method;
    this.path = path;
    this.callback = callback;
  }

  handler: RequestHandler = async (req, res, next) => {
    if (req.method === this.method) {
      try {
        const stream: Stream<T> = (response) => {
          if (Buffer.isBuffer(response)) res.write(response);
          else res.write(JSON.stringify(response) + "\n");
        };
        const result = await this.callback(req, res, stream);
        if (Buffer.isBuffer(result)) res.send(result);
        else if (result) res.json(result);
        else res.end();
        return;
      } catch (error: unknown) {
        logger.error("Route handler error", { method: this.method, path: this.path }, error);
        sendAlarm(
          `Route Error: ${this.method} ${this.path}`,
          `**Error:** ${error instanceof Error ? error.message : String(error)}`
        ).catch(() => undefined);
        const message =
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : error instanceof Error
              ? error.message
              : String(error);
        res.status(500).json({ status: "error", message });
      }
    }
    next();
  };

  register = (router: Router) => {
    router.use(this.path, this.handler);
  };
}

export const AUTH_ERROR_MESSAGE = "Request user is not logged in.";

/**
 * Middleware that rejects unauthenticated requests with a 401.
 * Apply at the router level so every route is protected by default —
 * explicitly exclude public paths instead of relying on each handler.
 */
export const authRequired = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session.user) {
    res.status(401).json({ status: "failed", message: AUTH_ERROR_MESSAGE });
    return;
  }
  next();
};
