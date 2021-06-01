import React, { createContext } from "react";
import ReactDOM from "react-dom";
import { Route, Switch, BrowserRouter } from "react-router-dom";
import { useQuery, QueryClient, QueryClientProvider } from "react-query";
import Home from "./Home";
import Box from "./Box";
import "./index.scss";

const domainName = process.env.REACT_APP_DOMAIN || "My Domain";

const queryClient = new QueryClient();

const Context = createContext();

const App = () => {
  const {
    isLoading,
    error,
    data: isLogin
  } = useQuery(
    "checkLogin",
    () => {
      return fetch("/admin").then((r) => r.json());
    },
    { cacheTime: 0 }
  );

  if (isLoading) {
    return (
      <>
        <h1>{domainName} Inbox</h1>
        <h3 className="greeting">Checking session...</h3>
      </>
    );
  }

  if (error) {
    return (
      <>
        <h1>{domainName} Inbox</h1>
        <h3 className="greeting">Server error</h3>
      </>
    );
  }

  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={{ isLogin }}>
          <BrowserRouter>
            <Switch>
              <Route exact path="/">
                <Home />
              </Route>
              <Route exact path="/box">
                <Box />
              </Route>
            </Switch>
          </BrowserRouter>
        </Context.Provider>
      </QueryClientProvider>
    </React.StrictMode>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));

export { Context };
