import { MailBodyDataType, isUuid } from "common";
import { getMailBody } from "server";
import { Route } from "../route";

export type BodyGetResponse = MailBodyDataType;

export const getBodyRoute = new Route<BodyGetResponse>(
  "GET",
  "/body/:id",
  async (req) => {
    const user = req.session.user!;

    // `mail_id` is a uuid column: a malformed id raises 22P02 rather than
    // matching nothing, and since the repository no longer swallows that it
    // would answer 500 and page the alarm channel. An id of the wrong shape is
    // a client error, so screen it here and keep the plain not-found (#747).
    if (!isUuid(req.params.id)) return { status: "failed", message: "No email is found." };

    const mail = await getMailBody(user.id, req.params.id);
    if (!mail) return { status: "failed", message: "No email is found." };
    return { status: "success", body: mail };
  }
);
