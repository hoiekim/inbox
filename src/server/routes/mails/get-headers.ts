import { MailHeaderDataType } from "common";
import {
  Route,
  getMailHeaders,
  addressToUsername,
  GetMailsOptions,
  AUTH_ERROR_MESSAGE
} from "server";

export type HeadersGetResponse = MailHeaderDataType[];

export const getHeadersRoute = new Route<HeadersGetResponse>(
  "GET",
  "/headers/:account",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const { username } = user;
    const usernameInAccount = addressToUsername(req.params.account);
    const valid = ["admin", usernameInAccount].includes(username);

    if (!valid) {
      return {
        status: "failed",
        message: "Invalid request. You may not look at other users' emails."
      };
    }

    const options: GetMailsOptions = {
      sent: !!req.query.sent,
      new: !!req.query.new,
      saved: !!req.query.saved
    };

    const mails = await getMailHeaders(user, req.params.account, options);
    return { status: "success", body: mails };
  }
);
