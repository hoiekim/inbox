import React, { useState, createContext } from "react";
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
  const [isLogin, setIsLogin] = useState(session);
  const [isWriterOpen, setIsWriterOpen] = useState(false);
  const [replyData, setReplyData] = useState({});

  // stores states to export with `Context`
  const contextValue = {
    isLogin,
    setIsLogin,
    isWriterOpen,
    setIsWriterOpen,
    replyData,
    setReplyData
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
