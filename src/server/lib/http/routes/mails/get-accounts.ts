import { Account } from "common";
import { getAccounts } from "server";
import { Route } from "../route";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
}

export const getAccountsRoute = new Route<AccountsGetResponse>(
  "GET",
  "/accounts",
  async (req) => {
    const user = req.session.user!;

    const accounts = await getAccounts(user);
    return { status: "success", body: { ...accounts } };
  }
);
