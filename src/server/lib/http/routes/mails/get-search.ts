import { MailHeaderDataType } from "common";
import { AUTH_ERROR_MESSAGE, searchMail } from "server";
import { Route } from "../route";

export type SearchGetResponse = MailHeaderDataType[];

export const getSearchRoute = new Route<SearchGetResponse>(
  "GET",
  "/search/:value",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const value = decodeURIComponent(req.params.value);
    const field = req.query.field as unknown as string | undefined;
    const result = await searchMail(user, value, field);

    return { status: "success", body: result };
  }
);
