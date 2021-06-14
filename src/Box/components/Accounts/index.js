import React, { useContext } from "react";
import { useQuery } from "react-query";

import SkeletonAccount from "./components/SkeletonAccount";
import SkeletonCategory from "./components/SkeletonCategory";
import SearchIcon from "./components/SearchIcon";

import { Context, categories } from "../../..";

import "./index.scss";

const Accounts = () => {
  const {
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory
  } = useContext(Context);

  const selectedCategoryName = categories[selectedCategory];

  const queryUrl = "/api/accounts";

  const getAccounts = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery(queryUrl, getAccounts, {
    onSuccess: (data) => data.new?.length && setSelectedCategory(0)
  });

  if (query.isLoading) {
    return (
      <div className="tab-holder">
        <div className="categories skeleton">
          <SkeletonCategory />
          <SkeletonCategory />
          <SkeletonCategory />
          <SkeletonCategory />
        </div>
        <div className="accounts">
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
        </div>
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="tab-holder">
        <div className="categories"></div>
        <div className="accounts">Accounts List Request Failed</div>
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
    const searchHistoreis = [];

    const renderAccount = (data, i) => {
      const accountName = data.key;
      const unreadNo = data.unread_doc_count;
      const onClickAccount = () => {
        if (selectedAccount !== accountName) setSelectedAccount(accountName);
      };

      const classes = ["tag"];
      if (selectedAccount === accountName) classes.push("clicked");
      else classes.push("cursor");

      return (
        <div key={i}>
          <h3 className={classes.join(" ")} onClick={onClickAccount}>
            <span>{accountName.split("@")[0]}</span>
            {unreadNo ? <div className="numberBall">{unreadNo}</div> : null}
          </h3>
        </div>
      );
    };

    let accountComponents;

    if (selectedCategoryName === "new") {
      accountComponents = (unreadAccounts || []).map(renderAccount);
    } else if (selectedCategoryName === "sent") {
      accountComponents = (sentAccounts || []).map(renderAccount);
    } else if (selectedCategoryName === "search") {
      accountComponents = (searchHistoreis || []).map(renderAccount);
    } else {
      accountComponents = (allAccounts || []).map(renderAccount);
    }

    const categoryComponents = categories.map((e, i) => {
      const onClickCategory = () => setSelectedCategory(i);
      const className = selectedCategory === i ? "clicked" : null;
      return (
        <div key={i} className={className} onClick={onClickCategory}>
          {e === "search" ? (
            <div className="flex">
              <SearchIcon />
            </div>
          ) : (
            e[0].toUpperCase() + e.substring(1)
          )}
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
