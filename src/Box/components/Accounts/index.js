import React, { useContext } from "react";
import { useQuery } from "react-query";

import { Context, categories } from "../../..";

import "./index.scss";

const Accounts = () => {
  const {
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory
  } = useContext(Context);

  const queryUrl = "/api/accounts";

  const getAccounts = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery(queryUrl, getAccounts, {
    onSuccess: (data) => {
      if (!data.new?.length) {
        setSelectedCategory(1);
      }
    }
  });

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
    const unreadAccounts = query.data?.new?.sort((a, b) =>
      a.key > b.key ? 1 : b.key > a.key ? -1 : 0
    );
    const allAccounts = query.data?.all?.sort((a, b) =>
      a.key > b.key ? 1 : b.key > a.key ? -1 : 0
    );
    const sentAccounts = query.data?.sent?.sort((a, b) =>
      a.key > b.key ? 1 : b.key > a.key ? -1 : 0
    );

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
      accountComponents = (unreadAccounts || []).map(renderAccount);
    } else if (categories[selectedCategory] === "sent") {
      accountComponents = (sentAccounts || []).map(renderAccount);
    } else {
      accountComponents = (allAccounts || []).map(renderAccount);
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
