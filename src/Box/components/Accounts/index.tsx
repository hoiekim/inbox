import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import SkeletonAccount from "./components/SkeletonAccount";
import SkeletonCategory from "./components/SkeletonCategory";
import SearchIcon from "./components/SearchIcon";
import RefreshIcon from "./components/RefreshIcon";
import LogoutIcon from "./components/LogoutIcon";

import { Context, categories, ContextType } from "src";
import { Account, AccountsResponse } from "routes/lib/mails";

import "./index.scss";

let searchDelay: NodeJS.Timeout, init: boolean;

const Accounts = () => {
  const [searchInputDom, setSearchInputDom] = useState<HTMLInputElement | null>(
    null
  );

  const {
    setUserInfo,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory,
    searchHistory,
    setSearchHistory
  } = useContext(Context) as ContextType;

  const queryUrl = "/api/accounts";

  const getAccounts = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery<AccountsResponse>(queryUrl, getAccounts, {
    onSuccess: (data) => {
      const newMailsExists = data.received.find((e) => e.unread_doc_count);
      if (newMailsExists && !init) setSelectedCategory("new");
      init = true;
    }
  });

  useEffect(() => {
    if (searchInputDom) searchInputDom.focus();
  }, [searchInputDom]);

  if (query.isLoading) {
    return (
      <div className="tab-holder">
        <div className="categories skeleton">
          <div>
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
          </div>
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
    const { received = [], sent = [] } = query.data || {};

    const renderAccount = (data: Account, i: number) => {
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
          <div className={classes.join(" ")} onClick={onClickAccount}>
            <span>{accountName.split("@")[0]}</span>
            {unreadNo ? <div className="numberBall">{unreadNo}</div> : null}
          </div>
        </div>
      );
    };

    let accountComponents: JSX.Element[] = [];

    if (selectedCategory === "new") {
      accountComponents = received
        .filter((e) => e.unread_doc_count)
        .sort((a, b) => {
          const dateA = +new Date(a.updated);
          const dateB = +new Date(b.updated);
          return dateB - dateA;
        })
        .map(renderAccount);
    } else if (selectedCategory === "all") {
      accountComponents = received
        .sort((a, b) => (a.key > b.key ? 1 : b.key > a.key ? -1 : 0))
        .map(renderAccount);
    } else if (selectedCategory === "sent") {
      accountComponents = sent
        .sort((a, b) => (a.key > b.key ? 1 : b.key > a.key ? -1 : 0))
        .map(renderAccount);
    } else if (selectedCategory === "search" && searchHistory) {
      accountComponents = searchHistory.map(renderAccount);
    }

    const categoryComponents = categories.map((e, i) => {
      const onClickCategory = () => {
        if (e === "search") setSelectedAccount("");
        setSelectedCategory(e);
      };
      const classes = [];
      if (selectedCategory === e) classes.push("clicked");
      if (e === "search") classes.push("flex");

      return (
        <div key={i} className={classes.join(" ")} onClick={onClickCategory}>
          {e === "search" ? (
            <SearchIcon />
          ) : (
            e[0].toUpperCase() + e.substring(1)
          )}
        </div>
      );
    });

    const onChangeSearch: React.ChangeEventHandler<HTMLInputElement> = (e) => {
      clearTimeout(searchDelay);
      searchDelay = setTimeout(() => {
        setSelectedAccount(e.target.value);
      }, 500);
    };

    const onKeyDownSearch: React.KeyboardEventHandler<HTMLInputElement> = (
      e: any
    ) => {
      console.log(e);
      if (e.key === "Enter") {
        setSearchHistory([
          {
            key: e.target.value,
            doc_count: 0,
            unread_doc_count: 0,
            updated: new Date()
          },
          ...searchHistory
        ]);
        setSelectedAccount(e.target.value);
      }
    };

    const onClickRefresh = () => {
      init = false;
      query.refetch();
    };

    const onClickLogout = () => {
      fetch("/user", { method: "DELETE" })
        .then((r) => r.json())
        .then((r) => {
          if (r === true) {
            setUserInfo(undefined);
            setSelectedAccount("");
          }
        });
    };

    return (
      <div className="tab-holder">
        <div className="categories">
          <div>{categoryComponents}</div>
          <div>
            <div className="flex">
              <RefreshIcon onClick={onClickRefresh} />
            </div>
            <div className="flex">
              <LogoutIcon onClick={onClickLogout} />
            </div>
          </div>
        </div>
        <div className="accounts">
          {selectedCategory === "search" ? (
            <div className="search_container">
              <div className="fieldName">
                <span>Search This:</span>
              </div>
              <input
                type="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck="false"
                onChange={onChangeSearch}
                onKeyDown={onKeyDownSearch}
                ref={(e) => e && setSearchInputDom(e)}
              />
            </div>
          ) : null}
          {accountComponents?.length
            ? accountComponents
            : "This category is empty"}
        </div>
      </div>
    );
  }
};

export default Accounts;
