import React, { useContext } from "react";

import WriteIcon from "./components/WriteIcon";
import LogoutIcon from "./components/LogoutIcon";

import { Context } from "../../..";

const Menu = () => {
  const { setIsLogin, isWriterOpen, setIsWriterOpen } = useContext(Context);

  const logout = () => {
    return fetch("/admin", {
      method: "DELETE"
    })
      .then((r) => r.json())
      .then((r) => {
        if (r) setIsLogin(false);
      });
  };

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div className="menu">
      <div id="write" className="iconBox">
        <WriteIcon className="cursor" onClick={onClickWriter} />
      </div>
      <div id="logout" className="iconBox">
        <LogoutIcon className="cursor" onClick={logout} />
      </div>
    </div>
  );
};

export default Menu;
