import React, { useState, createContext, useEffect } from "react";
import ReactDOM from "react-dom";
import { QueryClient, QueryClientProvider } from "react-query";

import Header from "./Header";

import Home from "./Home";
import Box from "./Box";

import "./index.scss";

const Context = createContext();

let session = false;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      cacheTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnmount: false,
      refetchOnReconnect: false,
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
  const [isLogin, setIsLogin] = useState(session);
  const [isAccountsOpen, setIsAccountsOpen] = useState(true);
  const [isWriterOpen, setIsWriterOpen] = useState(false);
  const [replyData, setReplyData] = useState({});
  const [fetchAccounts, setFetchAccounts] = useState(0);

  useEffect(() => {
    window.addEventListener("resize", () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    });
  }, []);

  // stores states to export with `Context`
  const contextValue = {
    viewSize,
    isLogin,
    setIsLogin,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen,
    replyData,
    setReplyData,
    fetchAccounts,
    setFetchAccounts
  };

  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={contextValue}>
          <Header />
          <div className="under_header">{isLogin ? <Box /> : <Home />}</div>
        </Context.Provider>
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
