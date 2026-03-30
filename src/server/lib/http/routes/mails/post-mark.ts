import {
  decrementBadgeCount,
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

    const body: MarkMailPostBody = req.body;
    const { mail_id, read, save } = body;

    const mail = await getMailBody(user.id, mail_id);

    if (!mail) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    if (read === true) {
      decrementBadgeCount([user]).catch((error) => logger.error("Failed to decrement badge count", {}, error));
      await markRead(user.id, mail_id);
    }

    if (typeof save === "boolean") await markSaved(user.id, mail_id, save);

    return { status: "success" };
  }
);
