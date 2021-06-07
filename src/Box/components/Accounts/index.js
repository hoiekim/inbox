import React, { useContext, useEffect } from "react";
import { useQuery } from "react-query";

import { Context } from "../../..";

import "./index.scss";

const Accounts = ({ selectedAccount, setSelectedAccount }) => {
  const { fetchAccounts } = useContext(Context);
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

    const result = accounts?.map((data, i) => {
      const account = data.key;
      const unreadNo = data.doc_count;
      const onClickAccount = () => {
        if (selectedAccount !== account) setSelectedAccount(account);
      };

      // TODO: below className is not working
      let className = "";
      if (selectedAccount === account) className = "tag clicked";
      else className = "tag cursor";

      return (
        <h3 key={i} className={className} onClick={onClickAccount}>
          <span>{account.split("@")[0]}</span>
          {unreadNo ? <div className="numberBall">{unreadNo}</div> : null}
        </h3>
      );
    });

    return result ? <div>{result}</div> : <></>;
  }
};

export default Accounts;
