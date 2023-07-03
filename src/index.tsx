import React from "react";
import ReactDOM from "react-dom/client";
import { App, UserInfoType, call } from "client";

import "./index.scss";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

const mountApp = async () => {
  const session: UserInfoType | undefined = await fetch("/user").then((r) =>
    r.json()
  );
  root.render(
    <React.StrictMode>
      <App session={session} />
    </React.StrictMode>
  );
};

mountApp();
