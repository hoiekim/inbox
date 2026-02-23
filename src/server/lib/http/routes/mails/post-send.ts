import { MailDataToSend, MailDataToSendType } from "common";
import { sendMail, AUTH_ERROR_MESSAGE, MailValidationError, MailSendingError } from "server";
import { Route } from "../route";

export type SendMailPostResponse = undefined;

export type SendMailPostBody = MailDataToSendType;

export const postSendMailRoute = new Route<SendMailPostResponse>(
  "POST",
  "/send",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const body: SendMailPostBody = req.body;
    const attachments = req.files?.attachments;

    try {
      await sendMail(user, new MailDataToSend({ ...body }), attachments);
      return { status: "success" };
    } catch (error) {
      if (error instanceof MailValidationError || error instanceof MailSendingError) {
        return { status: "failed", message: error.message };
      }
      throw error;
    }
  }
);
