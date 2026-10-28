import { AUTH_ERROR_MESSAGE, getAttachmentFile, mailsTable } from "server";
import { Route } from "../route";

export const getAttachmentRoute = new Route<Bun.BunFile>(
  "GET",
  "/attachment/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const attachmentId = req.params.id;

    // Single query: verify ownership AND confirm attachment exists on this user's mail.
    // mailsTable.queryOne uses JSONB @> containment for the attachments filter.
    const mail = await mailsTable.queryOne({
      user_id: user.id,
      attachments: [{ content: { data: attachmentId } }],
    });
    if (!mail) return { status: "failed", message: "Not found" };

    const attachment = await getAttachmentFile(attachmentId);
    if (attachment === undefined) return { status: "failed" };
    return attachment;
  }
);
