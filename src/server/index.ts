import { MaskedUser } from "./routes";

declare module "express-session" {
  export interface SessionData {
    user: MaskedUser;
  }
}

export * from "./lib";
export * from "./routes";
