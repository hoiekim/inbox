import { Route, Account, getAccounts, AUTH_ERROR_MESSAGE } from "server";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
}

export const getAccountsRoute = new Route<AccountsGetResponse>(
  "GET",
  "/accounts",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const accounts = await getAccounts(user);
    return { status: "success", body: { ...accounts } };
  }
);
