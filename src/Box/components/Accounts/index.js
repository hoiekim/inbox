import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import { Context, categories } from "../../..";

import "./index.scss";

const Accounts = () => {
  const {
    fetchAccounts,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory
  } = useContext(Context);

  const [unreadAccounts, setUnreadAccounts] = useState([]);
  const [allAccounts, setAllAccounts] = useState([]);
  const [sentAccounts, setSentAccounts] = useState([]);

  const getAccounts = () => fetch("/api/accounts").then((r) => r.json());
  const query = useQuery("getAccounts", getAccounts);

  useEffect(() => {
    if (fetchAccounts && query.refetch) query.refetch();
  }, [fetchAccounts, query]);

  useEffect(() => {
    if (query.data && setSelectedCategory) {
      const allAccounts = query.data.received;
      const sentAccounts = query.data.sent;
      setAllAccounts(allAccounts);
      setSentAccounts(sentAccounts);

      const unreadAccounts = [];

      allAccounts.forEach((account) => {
        if (account.unread_doc_count) unreadAccounts.push(account);
      });

      if (unreadAccounts.length) {
        setUnreadAccounts(unreadAccounts);
        setSelectedCategory(0);
      }
    }
  }, [query.data, setSelectedCategory]);

  if (query.isLoading) {
    return (
      <div className="tab-holder">
        <div className="categories"></div>
        <div className="loading">Loading Accounts List...</div>
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="tab-holder">
        <div className="categories"></div>
        <div className="loading">Accounts List Request Failed</div>
      </div>
    );
  }

  if (query.isSuccess) {
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
        <div key={i}>
          <h3 className={classes.join(" ")} onClick={onClickAccount}>
            <span>{sent ? "Sent" : accountName.split("@")[0]}</span>
            {unreadNo ? <div className="numberBall">{unreadNo}</div> : null}
          </h3>
        </div>
      );
    };

    let accountComponents;

    if (categories[selectedCategory] === "new") {
      accountComponents = unreadAccounts.map(renderAccount);
    } else if (categories[selectedCategory] === "sent") {
      accountComponents = sentAccounts.map(renderAccount);
    } else {
      accountComponents = allAccounts.map(renderAccount);
    }

    const categoryComponents = categories.map((e, i) => {
      const onClickCategory = () => setSelectedCategory(i);
      const className = selectedCategory === i ? "clicked" : null;
      return (
        <div key={i} className={className} onClick={onClickCategory}>
          {e[0].toUpperCase() + e.substring(1)}
        </div>
      );
    });

    return (
      <div className="tab-holder">
        <div className="categories">{categoryComponents}</div>
        <div className="accounts">{accountComponents}</div>
      </div>
    );
  }
};

export default Accounts;
