import { AUTH_ERROR_MESSAGE, getAttachment, isAttachmentOwnedByUser } from "server";
import { Route } from "../route";

export const getAttachmentRoute = new Route<Buffer>(
  "GET",
  "/attachment/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const attachmentId = req.params.id;

    // Verify the attachment belongs to a mail owned by this user (IDOR prevention)
    const owned = await isAttachmentOwnedByUser(attachmentId, user.id);
    if (!owned) return { status: "failed", message: "Not found" };

    const attachment = await getAttachment(attachmentId);
    if (attachment === undefined) return { status: "failed" };
    return attachment;
  }
);
