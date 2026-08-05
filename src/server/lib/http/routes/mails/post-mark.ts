import {
  push,
  getMailBody,
  markRead,
  markSaved
} from "server";
import { Route } from "../route";
import { logger } from "../../../logger";

export type MarkMailPostResponse = undefined;

export interface MarkMailPostBody {
  mail_id: string;
  read?: boolean;
  save?: boolean;
}

export const postMarkMailRoute = new Route<MarkMailPostResponse>(
  "POST",
  "/mark",
  async (req) => {
    const user = req.session.user!;

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "failed", message: "Invalid request body." };
    }

    const { mail_id, read, save } = body as Record<string, unknown>;

    if (typeof mail_id !== "string" || !mail_id) {
      return { status: "failed", message: "mail_id must be a non-empty string" };
    }

    const mail = await getMailBody(user.id, mail_id);

    if (!mail) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    // The repositories catch their own errors and report the outcome as a
    // boolean, so an unreported failure here would answer success for a write
    // that never landed — and, for `read`, would have already decremented the
    // badge for a mail that stayed unread.
    if (read === true) {
      if (!(await markRead(user.id, mail_id))) {
        return { status: "failed", message: "Failed to mark the mail read" };
      }
      push
        .decrementBadgeCount([user])
        .catch((error) =>
          logger.error("Failed to decrement badge count", {}, error)
        );
    }

    if (typeof save === "boolean") {
      if (!(await markSaved(user.id, mail_id, save))) {
        return { status: "failed", message: "Failed to update the saved flag" };
      }
    }

    return { status: "success" };
  }
);
