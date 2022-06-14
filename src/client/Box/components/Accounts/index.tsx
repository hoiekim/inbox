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

import { Context, Category, useLocalStorage, QueryCache } from "client";
import { MailsSynchronizer } from "client/Box";
import { Account, AccountsResponse } from "server";

import "./index.scss";

const queryUrl = "/api/accounts";

export class AccountsCache extends QueryCache<AccountsResponse> {
  constructor() {
    super(queryUrl);
  }
}

let isFetched = false;

enum SortBy {
  Date = "Sort by Date",
  Size = "Sort by Size",
  Name = "Sort by Name"
}

let searchDelay: NodeJS.Timeout;

const Accounts = ({
  setPage
}: {
  setPage: React.Dispatch<React.SetStateAction<number>>;
}) => {
  const [searchInputDom, setSearchInputDom] = useState<HTMLInputElement | null>(
    null
  );
  const [sortBy, setSortBy] = useLocalStorage<SortBy>("sortBy", SortBy.Name);
  const [sortAscending, setSortAscending] = useLocalStorage(
    "sortAscending",
    true
  );
  const [showSortOptions, setShowSortOptions] = useState(false);

  const {
    viewSize,
    setUserInfo,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory,
    searchHistory,
    setSearchHistory,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    newMailsTotal,
    setNewMailsTotal,
    setLastUpdate
  } = useContext(Context);

  const getAccounts = () => {
    isFetched = false;
    return fetch(queryUrl).then((r) => r.json());
  };

  const onSuccess = (data: AccountsResponse) => {
    const { newMails, lastUpdate } = data.received.reduce(
      (acc, e) => {
        const updated = new Date(e.updated);
        return {
          newMails: acc.newMails + e.unread_doc_count,
          lastUpdate: acc.lastUpdate > updated ? acc.lastUpdate : updated
        };
      },
      { newMails: 0, lastUpdate: new Date(0) }
    );

    setNewMailsTotal(newMails);
    setLastUpdate(lastUpdate);

    if (!isFetched) {
      const sync = new MailsSynchronizer(selectedAccount, selectedCategory);
      if (sync.difference > 0) sync.refetchMails();
      isFetched = true;
    }
  };

  const query = useQuery<AccountsResponse>(queryUrl, getAccounts, {
    onSuccess,
    cacheTime: Infinity,
    refetchInterval: 1000 * 60 * 10,
    refetchIntervalInBackground: true,
    refetchOnMount: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: false,
    retry: false
  });

  useEffect(() => {
    if (searchInputDom && isAccountsOpen && !isWriterOpen)
      searchInputDom.focus();
  }, [searchInputDom, isAccountsOpen, isWriterOpen]);

  const touchStartHandler = () => setShowSortOptions(false);

  useEffect(() => {
    window.addEventListener("touchstart", touchStartHandler);
    return () => {
      window.removeEventListener("touchstart", touchStartHandler);
    };
  }, []);

  if (query.isLoading) {
    return (
      <div className="tab-holder">
        <div className="categories skeleton">
          <div>
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
          </div>
          <div>
            <SkeletonCategory />
            <SkeletonCategory />
          </div>
        </div>
        <div className="accounts">
          <div className="sort_box">
            <div />
          </div>
          <SkeletonAccount />
          <SkeletonAccount />
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
        if (selectedAccount !== accountName) {
          setPage(1);
          setSelectedAccount(accountName);
          if (viewSize.width <= 750) setIsAccountsOpen(false);
        }
      };

      const classes = ["tag"];
      if (selectedAccount === accountName) classes.push("clicked");
      else classes.push("cursor");

      return (
        <div key={i}>
          <div className={classes.join(" ")} onClick={onClickAccount}>
            <span>{accountName.split("@")[0]}</span>
            {unreadNo && selectedCategory !== Category.SavedMails ? (
              <div className="numberBall">{unreadNo}</div>
            ) : null}
          </div>
        </div>
      );
    };

    let sortedAccountData: Account[] = [];

    if (selectedCategory === Category.NewMails) {
      sortedAccountData = received.filter((e) => e.unread_doc_count);
    } else if (selectedCategory === Category.AllMails) {
      sortedAccountData = received;
    } else if (selectedCategory === Category.SavedMails) {
      sortedAccountData = received.filter((e) => e.saved_doc_count);
    } else if (selectedCategory === Category.SentMails) {
      sortedAccountData = sent;
    } else if (selectedCategory === Category.Search && searchHistory) {
      sortedAccountData = searchHistory;
    }

    const sortingFactor = 2 * +sortAscending - 1;

    if (sortBy === SortBy.Name) {
      sortedAccountData.sort(
        (a, b) => (2 * +(a.key > b.key) - 1) * sortingFactor
      );
    } else if (sortBy === SortBy.Date) {
      sortedAccountData.sort(
        (a, b) => (+new Date(a.updated) - +new Date(b.updated)) * sortingFactor
      );
    } else if (sortBy === SortBy.Size) {
      const sortKey =
        selectedCategory === Category.NewMails
          ? "unread_doc_count"
          : selectedCategory === Category.SavedMails
          ? "saved_doc_count"
          : "doc_count";
      sortedAccountData.sort(
        (a, b) => (a[sortKey] - b[sortKey]) * sortingFactor
      );
    }

    const accountComponents = sortedAccountData.map(renderAccount);

    const categoryComponents = Object.values(Category).map((e, i) => {
      const onClickCategory = () => {
        setSelectedAccount("");
        setSelectedCategory(e);
      };
      const classes = [];
      if (selectedCategory === e) classes.push("clicked");
      if (e === Category.Search) classes.push("flex");

      return (
        <div key={i} className={classes.join(" ")} onClick={onClickCategory}>
          {e === Category.Search ? (
            <SearchIcon />
          ) : (
            <div>
              {e.split(" ")[0]}
              {e === Category.NewMails &&
              e !== selectedCategory &&
              newMailsTotal ? (
                <div className="numberBall" />
              ) : (
                <></>
              )}
            </div>
          )}
        </div>
      );
    });

    const sortOptionComponents = Object.values(SortBy).map((e, i) => {
      const onClickSortOption = () => {
        if (e !== sortBy) {
          setSortBy(e);
          if (e === SortBy.Name) setSortAscending(true);
          else setSortAscending(false);
        }
        setShowSortOptions(false);
      };

      return (
        <div
          key={i}
          className="sort_option cursor"
          onClick={onClickSortOption}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {e}
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
      if (e.key === "Enter") {
        setSearchHistory([
          {
            key: e.target.value,
            doc_count: 0,
            unread_doc_count: 0,
            saved_doc_count: 0,
            updated: new Date()
          },
          ...searchHistory
        ]);
        setSelectedAccount(e.target.value);
        if (viewSize.width <= 750) setIsAccountsOpen(false);
      }
    };

    const onClickRefresh = () => {
      query.refetch();
      setSelectedAccount("");
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
            {showSortOptions ? (
              <></>
            ) : (
              <div
                className="sort_icon cursor"
                onClick={() => setSortAscending(!sortAscending)}
              >
                <div>
                  <SortDownIcon className={sortAscending ? "" : "highlight"} />
                  <SortUpIcon className={sortAscending ? "highlight" : ""} />
                </div>
              </div>
            )}
            <div>
              {showSortOptions ? (
                <></>
              ) : (
                <div
                  className="sort_current cursor"
                  onClick={() => setShowSortOptions(true)}
                >
                  {sortBy.split(" ").pop()}
                </div>
              )}
              {showSortOptions ? (
                <div
                  className="sort_select"
                  onMouseLeave={() => setShowSortOptions(false)}
                >
                  {sortOptionComponents}
                </div>
              ) : (
                <></>
              )}
            </div>
          </div>
          <div className="tags_container">
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

  return <></>;
};

export default Accounts;
