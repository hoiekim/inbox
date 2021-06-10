import React, { useContext, useEffect } from "react";
import { useQuery } from "react-query";

import { Context } from "../../..";

import "./index.scss";

const Accounts = () => {
  const { fetchAccounts, selectedAccount, setSelectedAccount } =
    useContext(Context);
  const getAccounts = () => fetch("/api/accounts").then((r) => r.json());
  const query = useQuery("getAccounts", getAccounts);

  useEffect(() => {
    if (fetchAccounts && query.refetch) query.refetch();
  }, [fetchAccounts, query]);

  if (query.isLoading) {
    return <div className="container">Loading Accounts List...</div>;
  }

  if (query.error) {
    return <div className="container">Accounts List Request Failed</div>;
  }

  if (query.isSuccess) {
    const allAccounts = query.data?.received || [];

    const sentAccounts = query.data?.sent || [];

    const unreadAccounts = [];

    allAccounts.forEach((account, i) => {
      if (account.unread_doc_count) unreadAccounts.push(account);
    });

    // TODO: how are we gonna fetch sent messages?
    const renderAccount = (data, i) => {
      const accountName = data.key;
      const sent = accountName === "sent.by.me";
      const unreadNo = sent ? 0 : data.unread_doc_count;
      const onClickAccount = () => {
        if (selectedAccount !== accountName) setSelectedAccount(accountName);
      };

      const classes = ["tag"];
      if (selectedAccount === accountName) classes.push("clicked");
      else classes.push("cursor");

      return (
        <h3 key={i} className={classes.join(" ")} onClick={onClickAccount}>
          <span>{sent ? "Sent" : accountName.split("@")[0]}</span>
          {unreadNo ? <div className="numberBall">{unreadNo}</div> : null}
        </h3>
      );
    };

    const newCategory = unreadAccounts.map(renderAccount);
    const sentCategory = sentAccounts.map(renderAccount);
    const allCategory = allAccounts.map(renderAccount);

    return (
      <>
        {newCategory.length ? (
          <div>
            <div>New</div>
            <div>{newCategory}</div>
          </div>
        ) : null}
        {sentCategory.length ? (
          <div>
            <div>Sent</div>
            <div>{sentCategory}</div>
          </div>
        ) : null}
        {allCategory.length ? (
          <div>
            <div>All</div>
            <div>{allCategory}</div>
          </div>
        ) : null}
      </>
    );
  }
};

export default Accounts;
