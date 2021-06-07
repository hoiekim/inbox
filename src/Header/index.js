import React, { useContext } from "react";
import LeftMenu from "./components/LeftMenu";
import RightMenu from "./components/RightMenu";
import { Context } from "..";

import "./index.scss";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

const Header = () => {
  const { isLogin } = useContext(Context);
  return (
    <div id="title_bar">
      {isLogin ? <LeftMenu /> : null}
      <h1>@{domainName}</h1>
      {isLogin ? <RightMenu /> : null}
    </div>
  );
};

export default Header;
