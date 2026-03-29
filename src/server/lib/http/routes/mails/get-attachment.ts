import path from "path";
import { AUTH_ERROR_MESSAGE, getAttachment, getMailByAttachmentId } from "server";
import { Route } from "../route";

export const getAttachmentRoute = new Route<Buffer>(
  "GET",
  "/attachment/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    // Sanitize ID to prevent path traversal attacks
    const id = path.basename(req.params.id);

    // Verify the attachment belongs to a mail owned by this user (IDOR prevention)
    const owned = await getMailByAttachmentId(user.id, id);
    if (!owned) return { status: "failed", message: "Attachment not found" };

    const attachment = await getAttachment(id);
    if (attachment === undefined) return { status: "failed" };
    return attachment;
  }
);
