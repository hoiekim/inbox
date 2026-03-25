import {
  useState,
  createContext,
  useEffect,
  useRef,
  StrictMode,
  Dispatch,
  SetStateAction
} from "react";
import { QueryClientProvider } from "react-query";
import { BrowserRouter, Switch, Route, Redirect } from "react-router-dom";

import { Account, SignedUser, ReplyData } from "common";
import { DomainGetResponse } from "server";

import { Header, SignIn, Box, SignUp, ErrorBoundary, useLocalStorage, Notifier, call, callUser, queryClient } from "client";

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
  userInfo: SignedUser | undefined;
  setUserInfo: Dispatch<SetStateAction<ContextType["userInfo"]>>;
  isAccountsOpen: boolean;
  setIsAccountsOpen: Dispatch<SetStateAction<ContextType["isAccountsOpen"]>>;
  isWriterOpen: boolean;
  setIsWriterOpen: Dispatch<SetStateAction<ContextType["isWriterOpen"]>>;
  replyData: ReplyData;
  setReplyData: Dispatch<SetStateAction<ContextType["replyData"]>>;
  selectedAccount: string;
  setSelectedAccount: Dispatch<SetStateAction<ContextType["selectedAccount"]>>;
  selectedCategory: Category;
  setSelectedCategory: Dispatch<
    SetStateAction<ContextType["selectedCategory"]>
  >;
  searchHistory: Account[];
  setSearchHistory: Dispatch<SetStateAction<ContextType["searchHistory"]>>;
  newMailsTotal: number;
  setNewMailsTotal: Dispatch<SetStateAction<ContextType["newMailsTotal"]>>;
}

export const Context = createContext<ContextType>({} as ContextType);

export interface UserInfoType {
  username: string;
}

interface Props {
  user?: SignedUser;
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
    Category.AllMails,
    // Search is transient (requires a live search query + preSearchAccount ref
    // that don't survive a page reload). Restoring Category.Search would use
    // the account address as the search term, producing confusing sort order.
    (v) => (v === Category.Search ? Category.AllMails : v)
  );
  const [searchHistory, setSearchHistory] = useState<
    ContextType["searchHistory"]
  >([]);
  const [newMailsTotal, setNewMailsTotal] = useState(0);

  // On mount: if the app reloaded while in search mode, exit search state.
  // The search query was stored in selectedAccount (a ref in Accounts component),
  // so we reset both to defaults to avoid showing stale search results on reload.
  useEffect(() => {
    if (selectedCategory === Category.Search) {
      setSelectedCategory(Category.AllMails);
      setSelectedAccount("");
    }
  }, []); // intentional: run once on mount only

  const lastRefresh = useRef(Date.now());

  useEffect(() => {
    const handleResize = () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    };
    const handleOrientationChange = () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    };
    const handleScroll = () => {
      window.scrollTo(window.scrollX, window.scrollY);
    };
    const handleFocus = async () => {
      const user = await callUser();
      if (!user) return;
      const duration = Date.now() - lastRefresh.current;
      const oneDay = 1000 * 60 * 60 * 24;
      if (duration < oneDay) return;
      new Notifier().subscribe();
      lastRefresh.current = Date.now();
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleOrientationChange);
    window.addEventListener("scroll", handleScroll);
    window.addEventListener("focus", handleFocus);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (!domainName) {
      call
        .get<DomainGetResponse>("/api/mails/domain")
        .then((r) => setDomainName(r.body || ""));
    }
  }, [domainName, setDomainName]);

  useEffect(() => {
    const noti = new Notifier();
    noti.clearBadge();
    noti.setBadge(newMailsTotal);
  }, [newMailsTotal]);

  useEffect(() => {
    if (!userInfo) {
      setSelectedAccount("");
      setSelectedCategory(Category.AllMails);
      setIsWriterOpen(false);
      setIsAccountsOpen(window.innerWidth > 750);
      setReplyData({});
      setSearchHistory([]);
      setNewMailsTotal(0);
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
    setNewMailsTotal
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
    setNewMailsTotal
  };

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={contextValue}>
          <BrowserRouter>
            <ErrorBoundary>
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
            </ErrorBoundary>
          </BrowserRouter>
        </Context.Provider>
      </QueryClientProvider>
    </StrictMode>
  );
};

export default App;
