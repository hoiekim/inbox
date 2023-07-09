import { AUTH_ERROR_MESSAGE, MailBodyData, Route, getMailBody } from "server";

export type BodyGetResponse = MailBodyData;

export const getBodyRoute = new Route<BodyGetResponse>(
  "GET",
  "/body/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const mail = await getMailBody(user.id, req.params.id);
    if (!mail) return { status: "failed", message: "No email is found." };
    return { status: "success", body: mail };
  }
);
