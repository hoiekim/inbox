import { Router, RequestHandler, Request, Response } from "express";

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
        console.error(error);
        const message = error instanceof Error ? error.message : String(error);
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
