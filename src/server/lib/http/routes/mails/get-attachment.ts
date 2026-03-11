import { AUTH_ERROR_MESSAGE, getAttachment, verifyAttachmentOwnership } from "server";
import { Route } from "../route";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getAttachmentRoute = new Route<Buffer>(
  "GET",
  "/attachment/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const { id } = req.params;

    // Validate UUID format before building file path
    if (!UUID_PATTERN.test(id)) {
      return { status: "failed", message: "Invalid attachment ID" };
    }

    // Verify the attachment belongs to the requesting user (prevent IDOR)
    const owned = await verifyAttachmentOwnership(user.id, id);
    if (!owned) return { status: "failed", message: "Attachment not found" };

    const attachment = await getAttachment(id);
    if (attachment === undefined) return { status: "failed" };
    return attachment;
  }
);
