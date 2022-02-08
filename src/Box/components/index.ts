import React from "react";

import { Category, queryClient } from "src";
import { AccountsCache } from "./Accounts";
import { MailsCache } from "./Mails";

export const Writer = React.lazy(() => import("./Writer"));
export const Mails = React.lazy(() => import("./Mails"));
export const Accounts = React.lazy(() => import("./Accounts"));

export { default as FileIcon } from "./FileIcon";

export class MailsSynchronizer {
  constructor(account: string, category: Category) {
    const accountsCache = new AccountsCache();
    this.accountsKey = accountsCache.key;

    const mailsCache = new MailsCache(account, category);
    this.mailsKey = mailsCache.key;

    if (account) {
      const accounts = accountsCache.get();
      const mails = mailsCache.get();

      if (!accounts || !mails) return;

      const accountsKey = category === Category.SentMails ? "sent" : "received";
      const accountData = accounts[accountsKey].find((e) => e.key === account);

      let countInAccounts: number;

      if (category === Category.NewMails)
        countInAccounts = accountData?.unread_doc_count || 0;
      else if (category === Category.SavedMails)
        countInAccounts = accountData?.saved_doc_count || 0;
      else countInAccounts = accountData?.doc_count || 0;

      const countInMails = mails.reduce((acc, e) => {
        switch (category) {
          case Category.NewMails:
            if (!e.read) return acc + 1;
            return acc;
          case Category.SavedMails:
            if (e.label === "saved") return acc + 1;
            return acc;
          default:
            return acc + 1;
        }
      }, 0);

      this.difference = countInAccounts - countInMails;
    }
  }

  private accountsKey: string;
  private mailsKey: string;

  /** countInAccounts - countInMails */
  public difference: number = 0;

  public refetchAccounts = () =>
    queryClient.refetchQueries([this.accountsKey], { exact: true });

  public refetchMails = () =>
    queryClient.refetchQueries([this.mailsKey], { exact: true });
}
