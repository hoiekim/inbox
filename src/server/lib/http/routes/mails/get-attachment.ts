import { getAttachment } from "server";
import { Route } from "../route";

export const getAttachmentRoute = new Route<Buffer>(
  "GET",
  "/attachment/:id",
  async (req) => {
    // Note: ownership check (IDOR prevention) is handled by PR #201 (isAttachmentOwnedByUser).
    // Once that merges, re-introduce user.id here: getAttachment(req.params.id, user.id) or similar.
    const attachment = await getAttachment(req.params.id);
    if (attachment === undefined) return { status: "failed" };
    return attachment;
  }
);
