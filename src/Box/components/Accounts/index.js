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
    const accounts = Array.isArray(query.data) ? query.data : null;

    for (const i in accounts) {
      const account = accounts[i];
      if (account.key.split("@")[0] === "sent.by.me") {
        accounts.splice(i, 1);
        accounts.unshift(account);
      }
    }

    const result = accounts?.map((data, i) => {
      const accountName = data.key;
      const unreadNo = data.doc_count;
      const onClickAccount = () => {
        if (selectedAccount !== accountName) setSelectedAccount(accountName);
      };

      let className = "";
      if (selectedAccount === accountName) className = "tag clicked";
      else className = "tag cursor";

      return (
        <h3 key={i} className={className} onClick={onClickAccount}>
          <span>{accountName.split("@")[0]}</span>
          {unreadNo ? <div className="numberBall">{unreadNo}</div> : null}
        </h3>
      );
    });

    return result ? <div>{result}</div> : <></>;
  }
};

export default Accounts;
