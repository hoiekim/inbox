import { MailHeaderData } from "common";
import { getSpamHeaders } from "server";
import { Route } from "../route";

export type SpamGetResponse = MailHeaderData[];

/**
 * Get all spam-flagged emails for the authenticated user.
 * Returns email headers for display in a spam folder view.
 */
export const getSpamMailsRoute = new Route<SpamGetResponse>(
  "GET",
  "/spam",
  async (req) => {
    const user = req.session.user!;

    const mails = await getSpamHeaders(user);
    return { status: "success", body: mails };
  }
);
