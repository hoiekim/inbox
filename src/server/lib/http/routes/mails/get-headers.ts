import { MailHeaderDataType } from "common";
import {
  getMailHeaders,
  getMailHeadersDelta,
  addressToUsername,
  GetMailsOptions
} from "server";
import { Route } from "../route";

// Full-list response (no `?since=`). Unchanged shape — old clients keep working.
export type HeadersGetResponse = MailHeaderDataType[];

// Delta response, returned only when the client sends `?since=<ISO>` (#457).
// `headers` are the rows changed since `since`; `expunged_ids` are rows
// expunged in that window so a cached client can evict them; `as_of` is the
// server view-time the client persists as the next `?since=` cursor.
export interface HeadersDeltaGetResponse {
  as_of: string;
  headers: MailHeaderDataType[];
  expunged_ids: string[];
}

export const getHeadersRoute = new Route<
  HeadersGetResponse | HeadersDeltaGetResponse
>(
  "GET",
  "/headers/:account",
  async (req) => {
    const user = req.session.user!;

    const { username } = user;
    const usernameInAccount = addressToUsername(req.params.account);
    const valid = ["admin", usernameInAccount].includes(username);

    if (!valid) {
      return {
        status: "failed",
        message: "Invalid request. You may not look at other users' emails."
      };
    }

    const options: GetMailsOptions = {
      sent: !!req.query.sent,
      new: !!req.query.new,
      saved: !!req.query.saved
    };

    const { since } = req.query;
    if (since !== undefined) {
      // Validate at the boundary: a malformed cursor must not silently fall
      // back to a full fetch (the client expects the delta shape) nor reach
      // the SQL layer (`updated > 'garbage'` would throw).
      if (typeof since !== "string" || Number.isNaN(Date.parse(since))) {
        return {
          status: "failed",
          message: "Invalid `since` parameter: expected an ISO timestamp."
        };
      }
      const delta = await getMailHeadersDelta(
        user,
        req.params.account,
        options,
        since
      );
      return { status: "success", body: delta };
    }

    const mails = await getMailHeaders(user, req.params.account, options);
    return { status: "success", body: mails };
  }
);
