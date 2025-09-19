import { getMailBody, deleteMail, AUTH_ERROR_MESSAGE } from "server";
import { Route } from "../route";

export type MailDeleteResponse = undefined;

export const deleteMailRoute = new Route<MailDeleteResponse>(
  "DELETE",
  "/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const mailId = req.params.id;
    const data = await getMailBody(user.id, mailId);

    if (!data) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    await deleteMail(mailId);
    return { status: "success" };
  }
);
