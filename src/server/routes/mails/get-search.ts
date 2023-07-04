import { MailHeaderType, Route, searchMail } from "server";

export type SearchGetResponse = MailHeaderType[];

export const getSearchRoute = new Route<SearchGetResponse>(
  "GET",
  "/search/:value",
  async (req) => {
    if (!req.session.user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const value = decodeURIComponent(req.params.value);
    const field = req.query.field as unknown as string | undefined;
    const { username } = req.session.user;
    const result = await searchMail(value, username, field);

    return { status: "success", body: result };
  }
);
