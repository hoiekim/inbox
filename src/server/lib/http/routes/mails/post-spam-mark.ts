import {
  getMailBody,
  markSpam,
  AUTH_ERROR_MESSAGE
} from "server";
import { Route } from "../route";

export type SpamMarkPostResponse = undefined;

export interface SpamMarkPostBody {
  mail_id: string;
  is_spam: boolean;
}

/**
 * Mark or unmark an email as spam.
 * When marking as spam, also adds sender to blocklist consideration.
 * When unmarking, user may want to add sender to allowlist.
 */
export const postSpamMarkRoute = new Route<SpamMarkPostResponse>(
  "POST",
  "/spam/mark",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const body: SpamMarkPostBody = req.body;
    const { mail_id, is_spam } = body;

    if (typeof is_spam !== "boolean") {
      return { status: "failed", message: "is_spam must be a boolean" };
    }

    const mail = await getMailBody(user.id, mail_id);

    if (!mail) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    await markSpam(mail_id, is_spam);
    return { status: "success" };
  }
);
