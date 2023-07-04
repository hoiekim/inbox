import {
  MailBodyType,
  Route,
  getMailBody,
  getUserDomain,
  validateMailAddress
} from "server";

export type BodyGetResponse = MailBodyType;

export const getBodyRoute = new Route<BodyGetResponse>(
  "GET",
  "/body/:id",
  async (req) => {
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const { username } = req.session.user;

    const mail = await getMailBody(req.params.id).catch(() => undefined);
    const userDomain = getUserDomain(username);
    const valid = validateMailAddress(mail, userDomain);

    if (!valid || !mail) {
      return {
        status: "failed",
        message: "Invalid request. You may not look at other users' emails."
      };
    }

    return { status: "success", body: mail };
  }
);
