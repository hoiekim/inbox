import { Account, Route, getAccounts } from "server";

export interface AccountsGetResponse {
  received: Account[];
  sent: Account[];
}

export const getAccountsRoute = new Route<AccountsGetResponse>(
  "GET",
  "/accounts",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not logged in." };
    }

    const accounts = await getAccounts(user.username);
    return { status: "success", body: { ...accounts } };
  }
);
