import React, { useState, createContext, useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "react-query";
import { BrowserRouter, Switch, Route, Redirect } from "react-router-dom";

import {
  Header,
  SignIn,
  Box,
  SignUp,
  useLocalStorage,
  Notifier,
  getLocalStorageItem
} from "client";
import { Account, MaskedUser } from "server";

export enum Category {
  NewMails = "New Mails",
  AllMails = "All Mails",
  SavedMails = "Saved Mails",
  SentMails = "Sent Mails",
  Search = "Search"
}

export interface ContextType {
  viewSize: {
    width: number;
    height: number;
  };
  domainName: string;
  userInfo: MaskedUser | undefined;
  setUserInfo: React.Dispatch<React.SetStateAction<ContextType["userInfo"]>>;
  isAccountsOpen: boolean;
  setIsAccountsOpen: React.Dispatch<
    React.SetStateAction<ContextType["isAccountsOpen"]>
  >;
  isWriterOpen: boolean;
  setIsWriterOpen: React.Dispatch<
    React.SetStateAction<ContextType["isWriterOpen"]>
  >;
  replyData: any;
  setReplyData: React.Dispatch<React.SetStateAction<ContextType["replyData"]>>;
  selectedAccount: string;
  setSelectedAccount: React.Dispatch<
    React.SetStateAction<ContextType["selectedAccount"]>
  >;
  selectedCategory: Category;
  setSelectedCategory: React.Dispatch<
    React.SetStateAction<ContextType["selectedCategory"]>
  >;
  searchHistory: Account[];
  setSearchHistory: React.Dispatch<
    React.SetStateAction<ContextType["searchHistory"]>
  >;
  newMailsTotal: number;
  setNewMailsTotal: React.Dispatch<
    React.SetStateAction<ContextType["newMailsTotal"]>
  >;
  lastUpdate: Date;
  setLastUpdate: React.Dispatch<
    React.SetStateAction<ContextType["lastUpdate"]>
  >;
}

export const Context = createContext<ContextType>({} as ContextType);

let lastNotifiedDate = new Date(0);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      cacheTime: Infinity,
      refetchInterval: 1000 * 60 * 10,
      refetchIntervalInBackground: true,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false
    }
  }
});

export interface UserInfoType {
  username: string;
}

interface Props {
  user?: MaskedUser;
}

const App = ({ user: session }: Props) => {
  // defines states used for UI control
  const [viewSize, setViewSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });
  const [domainName, setDomainName] = useLocalStorage("domainName", "");
  const [userInfo, setUserInfo] = useState(session);
  const [isAccountsOpen, setIsAccountsOpen] = useLocalStorage(
    "isAccountsOpen",
    window.innerWidth > 750
  );
  const [isWriterOpen, setIsWriterOpen] = useLocalStorage(
    "isWriterOpen",
    false
  );
  const [replyData, setReplyData] = useState({});
  const [selectedAccount, setSelectedAccount] = useLocalStorage(
    "selectedAccount",
    ""
  );
  const [selectedCategory, setSelectedCategory] = useLocalStorage(
    "selectedCategory",
    Category.AllMails
  );
  const [searchHistory, setSearchHistory] = useState<
    ContextType["searchHistory"]
  >([]);
  const [newMailsTotal, setNewMailsTotal] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(lastNotifiedDate);

  const lastRefresh = useRef(Date.now());

  useEffect(() => {
    window.addEventListener("resize", () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    });
    window.addEventListener("orientationchange", () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    });
    window.addEventListener("scroll", () => {
      window.scrollTo(window.scrollX, window.scrollY);
    });
    window.addEventListener("focus", () => {
      if (Date.now() - lastRefresh.current < 1000 * 60 * 60 * 24) return;
      const push_subscription_id = getLocalStorageItem("push_subscription_id");
      if (push_subscription_id) {
        fetch("/push/refresh/" + push_subscription_id);
      }
      lastRefresh.current = Date.now();
    });

    const push_subscription_id = getLocalStorageItem("push_subscription_id");
    if (push_subscription_id) {
      fetch("/push/refresh/" + push_subscription_id);
    }
  }, []);

  useEffect(() => {
    if (!domainName) {
      fetch("/api/domainName")
        .then((r) => r.text())
        .then(setDomainName);
    }
  }, [domainName, setDomainName]);

  useEffect(() => {
    const noti = new Notifier();
    noti.clearBadge();
    noti.setBadge(newMailsTotal);
    if (newMailsTotal && lastNotifiedDate < lastUpdate) {
      const title =
        newMailsTotal > 1
          ? `You have ${newMailsTotal} new mails`
          : "You have a new mail";
      noti.notify({
        title,
        icon: "/icons/logo192.png"
      });
      lastNotifiedDate = lastUpdate;
    }
  }, [newMailsTotal, lastUpdate]);

  useEffect(() => {
    if (!userInfo) {
      setSelectedAccount("");
      setSelectedCategory(Category.AllMails);
      setIsWriterOpen(false);
      setIsAccountsOpen(window.innerWidth > 750);
      setReplyData({});
      setSearchHistory([]);
      setNewMailsTotal(0);
      setLastUpdate(new Date(0));
    } else {
      new Notifier().subscribe();
    }
  }, [
    userInfo,
    setSelectedAccount,
    setSelectedCategory,
    setIsWriterOpen,
    setIsAccountsOpen,
    setReplyData,
    setSearchHistory,
    setNewMailsTotal,
    setLastUpdate
  ]);

  // stores states to export with `Context`
  const contextValue: ContextType = {
    viewSize,
    userInfo,
    setUserInfo,
    domainName,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen,
    replyData,
    setReplyData,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory,
    searchHistory,
    setSearchHistory,
    newMailsTotal,
    setNewMailsTotal,
    lastUpdate,
    setLastUpdate
  };

  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={contextValue}>
          <BrowserRouter>
            <Header />
            <Switch>
              <Route exact path="/">
                {userInfo ? <Box /> : <Redirect to="/sign-in" />}
              </Route>
              <Route exact path="/sign-in">
                {userInfo ? <Redirect to="/" /> : <SignIn />}
              </Route>
              <Route exact path={["/set-info", "/set-info/:email"]}>
                {userInfo ? <Redirect to="/" /> : <SignUp />}
              </Route>
            </Switch>
          </BrowserRouter>
        </Context.Provider>
      </QueryClientProvider>
    </React.StrictMode>
  );
};

export default App;
