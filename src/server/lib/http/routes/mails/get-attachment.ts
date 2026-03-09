import { getAttachment } from "server";
import { Route } from "../route";

export const getAttachmentRoute = new Route<Buffer>(
  "GET",
  "/attachment/:id",
  async (req) => {
    const user = req.session.user!;
    const attachment = await getAttachment(req.params.id);
    if (attachment === undefined) return { status: "failed" };
    return attachment;
  }
);
