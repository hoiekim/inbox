import React from "react";
import ReactDOM from "react-dom";
import { App, UserInfoType } from "client";

import "./index.scss";

const mountApp = async () => {
  const session: UserInfoType | undefined = await fetch("/user").then((r) =>
    r.json()
  );
  ReactDOM.render(<App session={session} />, document.getElementById("root"));
};

mountApp();
