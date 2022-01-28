import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import {
  SkeletonAccount,
  SkeletonCategory,
  SearchIcon,
  RefreshIcon,
  LogoutIcon,
  SortDownIcon,
  SortUpIcon
} from "./components";

import { Context, ContextType, Category } from "src";
import { useLocalStorage } from "src/lib";
import { Account, AccountsResponse } from "routes/lib/mails";

import "./index.scss";

enum SortBy {
  Date = "Sort by Date",
  Size = "Sort by Size",
  Name = "Sort by Name"
}

let searchDelay: NodeJS.Timeout, init: boolean;

const Accounts = () => {
  const [searchInputDom, setSearchInputDom] = useState<HTMLInputElement | null>(
    null
  );
  const [sortBy, setSortBy] = useLocalStorage<SortBy>("sortBy", SortBy.Name);
  const [sortAscending, setSortAscending] = useLocalStorage("sortBy", true);

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
      if (newMailsExists && !init) setSelectedCategory(Category.NewMails);
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

    if (selectedCategory === Category.NewMails) {
      accountComponents = received
        .filter((e) => e.unread_doc_count)
        .sort((a, b) => {
          const dateA = +new Date(a.updated);
          const dateB = +new Date(b.updated);
          return dateB - dateA;
        })
        .map(renderAccount);
    } else if (selectedCategory === Category.AllMails) {
      accountComponents = received
        .sort((a, b) => (a.key > b.key ? 1 : b.key > a.key ? -1 : 0))
        .map(renderAccount);
    } else if (selectedCategory === Category.SentMails) {
      accountComponents = sent
        .sort((a, b) => (a.key > b.key ? 1 : b.key > a.key ? -1 : 0))
        .map(renderAccount);
    } else if (selectedCategory === Category.Search && searchHistory) {
      accountComponents = searchHistory.map(renderAccount);
    }

    const categoryComponents = Object.values(Category).map((e, i) => {
      const onClickCategory = () => {
        if (e === Category.Search) setSelectedAccount("");
        setSelectedCategory(e);
      };
      const classes = [];
      if (selectedCategory === e) classes.push("clicked");
      if (e === Category.Search) classes.push("flex");

      return (
        <div key={i} className={classes.join(" ")} onClick={onClickCategory}>
          {e === Category.Search ? <SearchIcon /> : e.split(" ")[0]}
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
          <div className="sort_box">
            <div className="sort_icon cursor">
              <div>
                <SortDownIcon className={sortAscending ? "highlight" : ""} />
                <SortUpIcon className={sortAscending ? "" : "highlight"} />
              </div>
            </div>
            <div>
              <div className="sort_current">{sortBy.split(" ").pop()}</div>
              <div className="sort_select">
                {Object.values(SortBy).map((e, i) => {
                  return (
                    <div
                      key={i}
                      className="sort_option cursor"
                      onClick={() => setSortBy(e)}
                    >
                      {e}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div>
            {selectedCategory === Category.Search ? (
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
      </div>
    );
  }
};

export default Accounts;
