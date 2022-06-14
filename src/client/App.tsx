import React, { useState, createContext, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "react-query";
import { BrowserRouter, Switch, Route, Redirect } from "react-router-dom";

import { Header, SignIn, Box, SignUp, useLocalStorage, Notifier } from "client";
import { Account } from "server";

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
  userInfo: UserInfoType | undefined;
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
  session: UserInfoType | undefined;
}

const App = ({ session }: Props) => {
  // defines states used for UI control
  const [viewSize, setViewSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });
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

    const noti = new Notifier();
    noti.requestPermission();
  }, []);

  useEffect(() => {
    const noti = new Notifier();
    noti.setBadge(newMailsTotal);
    if (newMailsTotal && lastNotifiedDate < lastUpdate) {
      const title =
        newMailsTotal > 1
          ? `You have ${newMailsTotal} unread messages`
          : "You have a unread message";
      noti.notify({
        title,
        icon: "/icons/logo192.png"
      });
      lastNotifiedDate = lastUpdate;
    }
  }, [newMailsTotal, lastUpdate]);

  // stores states to export with `Context`
  const contextValue: ContextType = {
    viewSize,
    userInfo,
    setUserInfo,
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
