import {
  Route,
  decrementBadgeCount,
  getMailBody,
  validateMailAddress,
  markRead,
  getUserDomain,
  markSaved
} from "server";

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
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const { username } = req.session.user;
    const body: MarkMailPostBody = req.body;
    const { mail_id, read, save } = body;

    const mail = await getMailBody(mail_id).catch(() => undefined);
    const userDomain = getUserDomain(username);
    const valid = validateMailAddress(mail, userDomain);

    if (!valid) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    if (read === true) {
      decrementBadgeCount([username]).catch(console.error);
      await markRead(mail_id);
    }

    if (save !== undefined) await markSaved(req.params.id, save);

    return { status: "success" };
  }
);
