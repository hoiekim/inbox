import { markSpam } from "server";
import { getMailById } from "server/lib/postgres/repositories/mails";
import { trainWithEmail } from "server/lib/spam/classifier";
import { Route } from "../route";
import { logger } from "../../../logger";

export type SpamMarkPostResponse = undefined;

export interface SpamMarkPostBody {
  mail_id: string;
  is_spam: boolean;
}

/**
 * Mark or unmark an email as spam.
 *
 * In addition to updating the is_spam flag, this route trains the per-user
 * Naive Bayes classifier with the email content so future similar emails
 * are automatically detected.
 *
 * Authorization is enforced at the repository layer via user_id in WHERE clause.
 */
export const postMarkSpamMailRoute = new Route<SpamMarkPostResponse>(
  "POST",
  "/spam/mark",
  async (req) => {
    const user = req.session.user!;

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

    // Train the Naive Bayes classifier with this feedback.
    // Fire-and-forget: classifier training failure must not break the user action.
    getMailById(user.id, mail_id)
      .then((mail) => {
        if (!mail) return;
        const emailContext = {
          subject: mail.subject ?? undefined,
          text: mail.text ?? undefined,
          html: mail.html ?? undefined,
          fromAddress: Array.isArray(mail.from_address) && mail.from_address.length > 0
            ? (mail.from_address[0] as { address?: string }).address
            : undefined,
        };
        return trainWithEmail(user.id, emailContext, is_spam);
      })
      .catch((error) => {
        logger.warn("[SpamFilter] Classifier training failed for feedback", { mail_id }, error);
      });

    return { status: "success" };
  }
);
