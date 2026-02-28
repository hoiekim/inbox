import { MailHeaderData } from "common";
import { getSpamHeaders, AUTH_ERROR_MESSAGE } from "server";
import { Route } from "../route";

export type SpamGetResponse = MailHeaderData[];

/**
 * Get all spam-flagged emails for the authenticated user.
 * Returns email headers for display in a spam folder view.
 */
export const getSpamRoute = new Route<SpamGetResponse>(
  "GET",
  "/spam",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const mails = await getSpamHeaders(user);
    return { status: "success", body: mails };
  }
);
