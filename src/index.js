import React, { useState, createContext, useEffect } from "react";
import ReactDOM from "react-dom";
import { Route, Redirect, Switch, BrowserRouter } from "react-router-dom";
import { useQuery, QueryClient, QueryClientProvider } from "react-query";

import Header from "./Header";
import LoadingPage from "./LoadingPage";
import ErrorPage from "./ErrorPage";
import NoPage from "./NoPage";

import Home from "./Home";
import Box from "./Box";

import "./index.scss";

const Context = createContext();

const AppBody = () => {
  // defines states used for UI control
  const [isLogin, setIsLogin] = useState(false);
  const [isWriterOpen, setIsWriterOpen] = useState(true);
  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [isAccountsOpen, setIsAccountsOpen] = useState(false);
  const [queryEnabled, setQueryEnabled] = useState(true);
  const [refetchAccounts, setRefetchAccounts] = useState(() => {});

  // stores states to export with `Context`
  const contextValue = {
    isLogin,
    setIsLogin,
    isWriterOpen,
    setIsWriterOpen,
    isCategoryOpen,
    setIsCategoryOpen,
    isAccountsOpen,
    setIsAccountsOpen,
    refetchAccounts,
    setRefetchAccounts
  };

  // checks session data from backend server and set `isLogin` state
  const checkLogin = () => fetch("/admin").then((r) => r.json());
  const queryData = useQuery("checkLogin", checkLogin, {
    cacheTime: 0,
    enabled: queryEnabled
  });

  useEffect(() => {
    if (queryData.isSuccess) {
      setIsLogin(queryData.data);
      setQueryEnabled(false);
    }
  }, [queryData]);

  const ConditionalSwitch = () => {
    // returns components conditionally: checking session
    if (queryData.isLoading) {
      return <LoadingPage />;
    }

    // returns components conditionally: checking session failed
    if (queryData.error) {
      return <ErrorPage />;
    }

    // returns components conditionally: logged in
    if (isLogin) {
      return (
        <Switch>
          {/* email app page */}
          <Route exact path="/box">
            <Box />
          </Route>
          {/* redirects to app page */}
          <Route exact path="/">
            <Redirect to="/box" />
          </Route>
          {/* render `NoPage` */}
          <Route>
            <NoPage />
          </Route>
        </Switch>
      );
    }

    // returns components conditionally: not logged in
    if (!isLogin) {
      return (
        <Switch>
          {/* landing page */}
          <Route exact path="/">
            <Home />
          </Route>
          {/* redirects to landing page */}
          <Route exact path="/box">
            <Redirect to="/" />
          </Route>
          {/* render `NoPage` */}
          <Route>
            <NoPage />
          </Route>
        </Switch>
      );
    }
  };

  return (
    <Context.Provider value={contextValue}>
      <BrowserRouter>
        <Header />
        <ConditionalSwitch />
      </BrowserRouter>
    </Context.Provider>
  );
};

const queryClient = new QueryClient();

const App = () => {
  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppBody />
      </QueryClientProvider>
    </React.StrictMode>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));

export { Context };
