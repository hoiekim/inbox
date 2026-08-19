import { MailBodyDataType, isUuid } from "common";
import { getMailBody } from "server";
import { Route } from "../route";

export type BodyGetResponse = MailBodyDataType;

export const getBodyRoute = new Route<BodyGetResponse>(
  "GET",
  "/body/:id",
  async (req) => {
    const user = req.session.user!;

    if (!isUuid(req.params.id)) return { status: "failed", message: "No email is found." };

    const mail = await getMailBody(user.id, req.params.id);
    if (!mail) return { status: "failed", message: "No email is found." };
    return { status: "success", body: mail };
  }
);
