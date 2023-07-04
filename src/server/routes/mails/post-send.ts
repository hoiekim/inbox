import { FileArray } from "express-fileupload";
import { Route, sendMail, MailToSend } from "server";

export type SendMailPostResponse = undefined;

export type SendMailPostBody = Omit<MailToSend, "username">;

export const postSendMailRoute = new Route<SendMailPostResponse>(
  "POST",
  "/send",
  async (req) => {
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const { username } = req.session.user;
    const body: SendMailPostBody = req.body;
    const attachments = req.files?.attachments as FileArray | undefined;

    await sendMail({ ...body, username }, attachments);

    return { status: "success" };
  }
);
