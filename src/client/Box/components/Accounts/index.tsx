import {
  useState,
  useRef,
  useContext,
  useEffect,
  Dispatch,
  SetStateAction,
  ChangeEventHandler,
  KeyboardEventHandler
} from "react";
import { useQuery } from "react-query";

import {
  SkeletonAccount,
  SkeletonCategory,
  SearchIcon,
  RefreshIcon,
  LogoutIcon,
  SettingsIcon,
  SortDownIcon,
  SortUpIcon,
  Allowlist
} from "./components";

import { Account } from "common";
import {
  AccountsGetResponse,
  LoginDeleteResponse,
  SearchAccountsGetResponse
} from "server";
import {
  Context,
  Category,
  useLocalStorage,
  QueryCache,
  call,
  onKeyboardActivate,
  clearCachedQueries,
  unregisterServiceWorker,
  useIsOnline
} from "client";
import { MailsSynchronizer } from "client/Box";
import { mergeSavedAccounts } from "./savedAccounts";

import "./index.scss";

const queryUrl = "/api/mails/accounts";

export class AccountsCache extends QueryCache<AccountsGetResponse> {
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
  setPage: Dispatch<SetStateAction<number>>;
}) => {
  const [searchInputDom, setSearchInputDom] = useState<HTMLInputElement | null>(
    null
  );
  const preSearchAccount = useRef<string>("");
  const [sortBy, setSortBy] = useLocalStorage<SortBy>("sortBy", SortBy.Name);
  const [sortAscending, setSortAscending] = useLocalStorage(
    "sortAscending",
    true
  );
  const [showSortOptions, setShowSortOptions] = useState(false);
  const [isAllowlistOpen, setIsAllowlistOpen] = useState(false);

  const {
    viewSize,
    setUserInfo,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    newMailsTotal,
    setNewMailsTotal
  } = useContext(Context);

  const { isOnline } = useIsOnline();

  const getAccounts = async () => {
    isFetched = false;
    const { status, body, message } = await call.get<AccountsGetResponse>(
      queryUrl
    );
    if (status === "success") return body as AccountsGetResponse;
    else throw new Error(message);
  };

  const onSuccess = (data: AccountsGetResponse) => {
    const newMails = data.received.reduce(
      (acc, e) => acc + e.unread_doc_count,
      0
    );

    setNewMailsTotal(newMails);

    if (!isFetched) {
      const sync = new MailsSynchronizer(selectedAccount, selectedCategory);
      if (sync.difference > 0) sync.refetchMails();
      isFetched = true;
    }
  };

  const query = useQuery<AccountsGetResponse>(queryUrl, getAccounts, {
    onSuccess,
    cacheTime: Infinity,
    refetchInterval: 1000 * 60 * 10,
    refetchIntervalInBackground: true,
    refetchOnMount: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: false,
    retry: false
  });

  // In search mode `selectedAccount` holds the search term. Fetch the accounts
  // that own a matching mail so the side-tab can list them (clicking one jumps
  // to that account's All view). Empty term → disabled, so the tab stays empty
  // until the user types.
  const searchValue =
    selectedCategory === Category.Search ? selectedAccount : "";
  const searchAccountsQuery = useQuery<SearchAccountsGetResponse>(
    ["/api/mails/search-accounts", searchValue],
    async () => {
      const { status, body, message } =
        await call.get<SearchAccountsGetResponse>(
          `/api/mails/search-accounts/${encodeURIComponent(searchValue)}`
        );
      if (status === "success") return body as SearchAccountsGetResponse;
      throw new Error(message);
    },
    { enabled: !!searchValue, cacheTime: 0, retry: false }
  );

  // Spam is grouped per account (like received/sent); the category-tab badge
  // sums unread across the spam accounts, mirroring how newMailsTotal sums the
  // received accounts. Both ride the accounts payload — no extra fetch.
  const spamUnread = (query.data?.spam ?? []).reduce(
    (acc, e) => acc + e.unread_doc_count,
    0
  );

  useEffect(() => {
    if (searchInputDom && isAccountsOpen && !isWriterOpen)
      searchInputDom.focus();
  }, [searchInputDom, isAccountsOpen, isWriterOpen]);

  // Auto-select the first received account on fresh login when no account is
  // stored in localStorage (e.g., first visit or cleared storage). Skipped in
  // Search mode, where an empty selectedAccount is the empty search term (a
  // fresh, not-yet-typed search) — auto-selecting an account there would turn
  // that account's address into a stray search keyword.
  useEffect(() => {
    if (
      !selectedAccount &&
      selectedCategory !== Category.Search &&
      query.isSuccess &&
      query.data?.received?.length
    ) {
      const firstKey = query.data.received[0].key;
      if (firstKey) setSelectedAccount(firstKey);
    }
  }, [selectedAccount, selectedCategory, query.isSuccess, query.data]);

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
    const { received = [], sent = [], spam = [] } = query.data || {};

    const renderAccount = (data: Account, i: number) => {
      const accountName = data.key;
      const unreadNo = data.unread_doc_count;
      const onClickAccount = () => {
        // A found account in the search side-tab jumps to that account's All
        // view (the search term lives in selectedAccount, so we must switch
        // category as well as the account).
        if (selectedCategory === Category.Search) {
          setPage(1);
          setSelectedCategory(Category.AllMails);
          setSelectedAccount(accountName);
          if (viewSize.width <= 750) setIsAccountsOpen(false);
          return;
        }
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
          <div
            className={classes.join(" ")}
            role="button"
            tabIndex={0}
            onClick={onClickAccount}
            onKeyDown={onKeyboardActivate(onClickAccount)}
          >
            <span>{accountName?.split("@")[0] || "Unknown"}</span>
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
      sortedAccountData = mergeSavedAccounts(received, sent);
    } else if (selectedCategory === Category.SentMails) {
      sortedAccountData = sent;
    } else if (selectedCategory === Category.SpamMails) {
      sortedAccountData = spam;
    } else if (selectedCategory === Category.Search) {
      sortedAccountData = searchAccountsQuery.data || [];
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
        if (e === Category.Search) {
          // Entering search: remember the current account to restore on exit,
          // and start from an empty term so the side-tab (found accounts) and
          // the mails list stay empty until the user types a keyword.
          preSearchAccount.current = selectedAccount;
          setSelectedCategory(e);
          setSelectedAccount("");
          return;
        }

        // The account to keep selected in the destination category. Leaving
        // search restores the pre-search account (selectedAccount currently
        // holds the search term, so we can't read it here); otherwise we keep
        // the current account.
        const candidate =
          selectedCategory === Category.Search
            ? preSearchAccount.current
            : selectedAccount;

        // The destination category's account list — used to fall back to its
        // first account when the candidate isn't present in it.
        let targetAccounts: Account[];
        if (e === Category.SentMails) targetAccounts = sent;
        else if (e === Category.NewMails) targetAccounts = received.filter((a) => a.unread_doc_count);
        else if (e === Category.SavedMails) targetAccounts = mergeSavedAccounts(received, sent);
        else if (e === Category.SpamMails) targetAccounts = spam;
        else targetAccounts = received;

        setSelectedCategory(e);
        if (candidate && targetAccounts.some((a) => a.key === candidate)) {
          if (candidate !== selectedAccount) setSelectedAccount(candidate);
        } else if (targetAccounts.length > 0) {
          setSelectedAccount(targetAccounts[0].key);
        }
      };
      const classes = [];
      if (selectedCategory === e) classes.push("clicked");
      if (e === Category.Search) classes.push("flex");

      return (
        <div
          key={i}
          className={classes.join(" ")}
          role="tab"
          tabIndex={0}
          aria-selected={selectedCategory === e}
          onClick={onClickCategory}
          onKeyDown={onKeyboardActivate(onClickCategory)}
        >
          {e === Category.Search ? (
            <SearchIcon />
          ) : (
            <div>
              {e.split(" ")[0]}
              {e !== selectedCategory &&
              ((e === Category.NewMails && newMailsTotal) ||
                (e === Category.SpamMails && spamUnread)) ? (
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

    const onChangeSearch: ChangeEventHandler<HTMLInputElement> = (e) => {
      clearTimeout(searchDelay);
      searchDelay = setTimeout(() => {
        setSelectedAccount(e.target.value);
      }, 500);
    };

    const onKeyDownSearch: KeyboardEventHandler<HTMLInputElement> = (e) => {
      if (e.key === "Enter") {
        const target = e.target as HTMLInputElement;
        // Search immediately instead of waiting out the debounce.
        clearTimeout(searchDelay);
        setSelectedAccount(target.value);
        if (viewSize.width <= 750) setIsAccountsOpen(false);
      }
    };

    const onClickRefresh = () => {
      query.refetch();
      setSelectedAccount("");
    };

    const onClickLogout = async () => {
      const confirmed = window.confirm("Are you sure you want to log out?");
      if (!confirmed) return;
      const response = await call.delete<LoginDeleteResponse>(
        "/api/users/login"
      );
      if (response.status !== "success") return;
      // Drop the IndexedDB query cache so the next user on this browser can't be
      // seeded with this user's cached mail headers (#457).
      await clearCachedQueries();
      // Tear down the SW + Cache Storage so the logged-out browser holds no
      // cached app shell / assets from this session (#458).
      await unregisterServiceWorker();
      // Clear compose draft data so it doesn't leak to the next user on this browser.
      // `originalMessage` is a legacy key removed in #668; `originalMessageMeta` is
      // the new small-payload key that holds only the reply target's id + labels.
      [
        "name",
        "to",
        "cc",
        "bcc",
        "subject",
        "sender",
        "initialContent",
        "originalMessage",
        "originalMessageMeta",
        "isCcOpen"
      ].forEach((key) => localStorage.removeItem(key));
      setUserInfo(undefined);
      setSelectedAccount("");
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
              <button
                className="icon-button"
                onClick={() => setIsAllowlistOpen(true)}
                aria-label="Allowlist settings"
                title="Allowlist"
              >
                <SettingsIcon />
              </button>
            </div>
            <div className="flex">
              <button
                className="icon-button"
                onClick={onClickLogout}
                aria-label="Logout"
                disabled={!isOnline}
                title={
                  isOnline
                    ? "Logout"
                    : "You're offline — reconnect to log out"
                }
              >
                <LogoutIcon />
              </button>
            </div>
          </div>
        </div>
        {isAllowlistOpen ? (
          <Allowlist onClose={() => setIsAllowlistOpen(false)} />
        ) : null}
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
            <div className="sort_text">
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
            {!showSortOptions && selectedCategory === Category.Search ? (
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
            {!showSortOptions && accountComponents?.length
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
