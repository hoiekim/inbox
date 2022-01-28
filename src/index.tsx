import React, { useState, createContext, useEffect } from "react";
import ReactDOM from "react-dom";
import { QueryClient, QueryClientProvider } from "react-query";
import { BrowserRouter, Switch, Route, Redirect } from "react-router-dom";

import Header from "./Header";

import SignIn from "./SignIn";
import Box from "./Box";
import SignUp from "./SignUp";

import { Account } from "routes/lib/mails";

import "./index.scss";

interface UserInfoType {
  username: string;
}

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
}

export const Context = createContext<ContextType | null>(null);

let session: UserInfoType | undefined;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      cacheTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: true,
      retry: false
    }
  }
});

const App = () => {
  // defines states used for UI control
  const [viewSize, setViewSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });
  const [userInfo, setUserInfo] = useState(session);
  const [isAccountsOpen, setIsAccountsOpen] = useState(true);
  const [isWriterOpen, setIsWriterOpen] = useState(false);
  const [replyData, setReplyData] = useState({});
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(Category.AllMails);
  const [searchHistory, setSearchHistory] = useState<
    ContextType["searchHistory"]
  >([]);

  useEffect(() => {
    window.addEventListener("resize", () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    });
    window.addEventListener("orientationchange", () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    });
  }, []);

  // stores states to export with `Context`
  const contextValue = {
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
    setSearchHistory
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

const mountApp = async () => {
  session = await fetch("/user").then((r) => r.json());
  ReactDOM.render(<App />, document.getElementById("root"));
};

mountApp();
