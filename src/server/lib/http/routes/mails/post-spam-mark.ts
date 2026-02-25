import { markSpam, AUTH_ERROR_MESSAGE } from "server";
import { Route } from "../route";

export type SpamMarkPostResponse = undefined;

export interface SpamMarkPostBody {
  mail_id: string;
  is_spam: boolean;
}

/**
 * Mark or unmark an email as spam.
 * Authorization is enforced at the repository layer via user_id in WHERE clause.
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

    const updated = await markSpam(user.id, mail_id, is_spam);

    if (!updated) {
      return {
        status: "failed",
        message: "Mail not found or you don't have permission"
      };
    }

    return { status: "success" };
  }
);
