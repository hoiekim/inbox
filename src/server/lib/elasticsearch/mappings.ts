import { PushSubscription } from "web-push";
import { DateString, MailType, SessionType, UserType } from "common";

export interface Document {
  type: "mail" | "user" | "session" | "push_subscription";
  mail?: MailType;
  user?: UserType;
  session?: SessionType;
  push_subscription?: PushSubscription;
  updated: DateString;
}
