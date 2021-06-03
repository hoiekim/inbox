import React, { useState, createContext } from "react";
import ReactDOM from "react-dom";
import { QueryClient, QueryClientProvider } from "react-query";

import Header from "./Header";

import Home from "./Home";
import Box from "./Box";

import "./index.scss";

const Context = createContext();

let session = false;

const AppBody = () => {
  // defines states used for UI control
  const [isLogin, setIsLogin] = useState(session);
  const [isWriterOpen, setIsWriterOpen] = useState(true);
  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [isAccountsOpen, setIsAccountsOpen] = useState(false);
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

  return (
    <Context.Provider value={contextValue}>
      <Header />
      {isLogin ? <Box /> : <Home />}
    </Context.Provider>
  );
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnmount: false,
      refetchOnReconnect: false,
      retry: false
    }
  }
});

const App = () => {
  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppBody />
      </QueryClientProvider>
    </React.StrictMode>
  );
};

const mountApp = async () => {
  session = await fetch("/admin").then((r) => r.json());
  ReactDOM.render(<App />, document.getElementById("root"));
};

mountApp();

export { Context };
