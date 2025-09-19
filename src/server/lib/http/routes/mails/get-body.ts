import { MailBodyDataType } from "common";
import { AUTH_ERROR_MESSAGE, getMailBody } from "server";
import { Route } from "../route";

export type BodyGetResponse = MailBodyDataType;

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
