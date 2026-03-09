import { getMailBody, deleteMail } from "server";
import { Route } from "../route";

export type MailDeleteResponse = undefined;

export const deleteMailRoute = new Route<MailDeleteResponse>(
  "DELETE",
  "/:id",
  async (req) => {
    const user = req.session.user!;

    const mailId = req.params.id;
    const data = await getMailBody(user.id, mailId);

    if (!data) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    await deleteMail(user.id, mailId);
    return { status: "success" };
  }
);
