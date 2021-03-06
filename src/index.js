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

const categories = ["new", "all", "sent"];

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
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(1);

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
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory
  };

  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={contextValue}>
          <Header />
          {isLogin ? <Box /> : <Home />}
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

export { Context, categories, queryClient };
