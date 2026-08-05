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

    if (read === true) {
      push.decrementBadgeCount([user]).catch((error) => logger.error("Failed to decrement badge count", {}, error));
      await markRead(user.id, mail_id);
    }

    if (typeof save === "boolean") await markSaved(user.id, mail_id, save);

    return { status: "success" };
  }
);
