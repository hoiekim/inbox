import { Account } from "common";
import { searchAccounts } from "server";
import { Route } from "../route";

export type SearchAccountsGetResponse = Account[];

export const getSearchAccountsRoute = new Route<SearchAccountsGetResponse>(
  "GET",
  "/search-accounts/:value",
  async (req) => {
    const user = req.session.user!;

    const value = req.params.value;
    const result = await searchAccounts(user, value);

    return { status: "success", body: result };
  }
);
