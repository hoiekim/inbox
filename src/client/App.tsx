import {
  useState,
  createContext,
  useEffect,
  useRef,
  StrictMode,
  Dispatch,
  SetStateAction
} from "react";
import { QueryClient, QueryClientProvider } from "react-query";
import { BrowserRouter, Switch, Route, Redirect } from "react-router-dom";

import { Account, SignedUser } from "common";
import { DomainGetResponse } from "server";

import {
  Header,
  SignIn,
  Box,
  SignUp,
  useLocalStorage,
  Notifier,
  call,
  getUser as callUser
} from "client";

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
  replyData: any;
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
  lastUpdate: Date;
  setLastUpdate: Dispatch<SetStateAction<ContextType["lastUpdate"]>>;
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
    window.addEventListener("focus", async () => {
      const user = await callUser();
      if (!user) return;
      const duration = Date.now() - lastRefresh.current;
      const oneDay = 1000 * 60 * 60 * 24;
      if (duration < oneDay) return;
      new Notifier().subscribe();
      lastRefresh.current = Date.now();
    });
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
    <StrictMode>
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
    </StrictMode>
  );
};

export default App;
