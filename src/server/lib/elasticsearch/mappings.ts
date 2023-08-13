import { PushSubscription } from "web-push";
import { DateString, Mail, SessionType, UserType } from "common";

export interface Document {
  type: string;
  mail?: Mail;
  user?: UserType;
  session?: SessionType;
  push_subscription?: PushSubscription;
  updated: DateString;
}
