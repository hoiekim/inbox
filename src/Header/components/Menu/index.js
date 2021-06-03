import React, { useContext } from "react";

import WriteIcon from "./components/WriteIcon";
import LogoutIcon from "./components/LogoutIcon";
import RefreshIcon from "./components/RefreshIcon";

import { Context } from "../../..";

const Menu = () => {
  const { setIsLogin, isWriterOpen, setIsWriterOpen, refetchAccounts } =
    useContext(Context);

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
    <div id="buttons">
      <div id="write" className="iconBox">
        <WriteIcon className="cursor" onClick={onClickWriter} />
      </div>
      <div id="refresh" className="iconBox">
        <RefreshIcon className="cursor" onClick={() => {}} />
      </div>
      <div id="logout" className="iconBox">
        <LogoutIcon className="cursor" onClick={logout} />
      </div>
    </div>
  );
};

export default Menu;
