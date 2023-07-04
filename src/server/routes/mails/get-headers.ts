import {
  GetMailsOptions,
  MailHeaderType,
  Route,
  addressToUsername,
  getMails
} from "server";

export type HeadersGetResponse = MailHeaderType[];

export const getHeadersRoute = new Route<HeadersGetResponse>(
  "GET",
  "/headers/:account",
  async (req) => {
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const { username } = req.session.user;
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

    const mails = await getMails(req.params.account, options);
    return { status: "success", body: mails };
  }
);
