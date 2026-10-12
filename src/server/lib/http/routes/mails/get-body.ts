import { MailBodyDataType, isUuid } from "common";
import { getMailBody, markRead, refuseReadOnly } from "server";
import { Route } from "../route";
import { logger } from "../../../logger";

export type BodyGetResponse = MailBodyDataType;

export const getBodyRoute = new Route<BodyGetResponse>(
  "GET",
  "/body/:id",
  async (req) => {
    const user = req.session.user!;

    if (!isUuid(req.params.id)) return { status: "failed", message: "No email is found." };

    const mail = await getMailBody(user.id, req.params.id);
    if (!mail) return { status: "failed", message: "No email is found." };

    // Reading a mail over HTTP marks it read — the HTTP equivalent of IMAP's
    // implicit \Seen on body fetch. The IMAP layer derives \Seen from the
    // stored read flag, so without this an HTTP read stays invisible to IMAP
    // clients. Best-effort: a failed mark must not fail the read itself.
    // Read-only sessions may read without marking.
    if (refuseReadOnly(user, "Marking mail").ok) {
      try {
        await markRead(user.id, req.params.id);
      } catch (error) {
        logger.error(
          "Failed to mark mail read on HTTP body fetch",
          { mail_id: req.params.id },
          error
        );
      }
    }

    return { status: "success", body: mail };
  }
);
