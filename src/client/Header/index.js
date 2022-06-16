import React, { useContext } from "react";
import LeftMenu from "./components/LeftMenu";
import RightMenu from "./components/RightMenu";
import { Context } from "..";

import "./index.scss";

const Header = () => {
  const { viewSize, domainName, userInfo, selectedAccount } =
    useContext(Context);

  const username = userInfo?.username;
  if (username && username !== "admin") {
    domainName = username + "." + domainName;
  }

  const title = !selectedAccount
    ? "@" + domainName
    : viewSize.width > 750
    ? selectedAccount
    : selectedAccount.split("@")[0];

  return (
    <div id="title_bar">
      {userInfo ? <LeftMenu /> : null}
      <h1>{title}</h1>
      {userInfo ? <RightMenu /> : null}
    </div>
  );
};

export default Header;
