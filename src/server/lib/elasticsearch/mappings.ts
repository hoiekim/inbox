import {
  DateString,
  MailType,
  SessionType,
  StoredPushSubscription,
  UserType
} from "common";

export interface Document {
  type: "mail" | "user" | "session" | "push_subscription";
  mail?: MailType;
  user?: UserType;
  session?: SessionType;
  push_subscription?: StoredPushSubscription;
  updated: DateString;
}
