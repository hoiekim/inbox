import React, { useContext } from "react";
import RightMenu from "./components/RightMenu";
import LeftMenu from "./components/LeftMenu";
import { Context } from "..";

import "./index.scss";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

const Header = () => {
  const { isLogin } = useContext(Context);
  return (
    <div id="title_bar" className={isLogin ? "space-between" : null}>
      {isLogin ? <LeftMenu /> : null}
      <h1>{domainName} Mail</h1>
      {isLogin ? <RightMenu /> : null}
    </div>
  );
};

export default Header;
