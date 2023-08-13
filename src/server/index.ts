import { SignedUser } from "common";

declare module "express-session" {
  export interface SessionData {
    user: SignedUser;
  }
}

export * from "./lib";
export * from "./routes";
