import React, { useContext } from "react";

import WriteIcon from "./components/WriteIcon";
import LogoutIcon from "./components/LogoutIcon";

import { Context } from "../../..";

const RightMenu = () => {
  const { setIsLogin, isWriterOpen, setIsWriterOpen, setSelectedAccount } =
    useContext(Context);

  const logout = () => {
    fetch("/admin", { method: "DELETE" })
      .then((r) => r.json())
      .then((r) => {
        if (r === true) {
          setIsLogin(false);
          setSelectedAccount("");
        }
      });
  };

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div className="menu right">
      <div id="write" className="iconBox">
        <WriteIcon className="cursor" onClick={onClickWriter} />
      </div>
      <div id="logout" className="iconBox">
        <LogoutIcon className="cursor" onClick={logout} />
      </div>
    </div>
  );
};

export default RightMenu;
