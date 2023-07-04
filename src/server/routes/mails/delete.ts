import {
  Route,
  deleteMail,
  getMailBody,
  getUserDomain,
  validateMailAddress
} from "server";

export type MailDeleteResponse = undefined;

export const deleteMailRoute = new Route<MailDeleteResponse>(
  "DELETE",
  "/:id",
  async (req) => {
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const id = req.params.id;
    const data = await getMailBody(id);
    const { username } = req.session.user;
    const userDomain = getUserDomain(username);
    const valid = validateMailAddress(data, userDomain);

    if (!valid || !data) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    await deleteMail(id);
    return { status: "success" };
  }
);
