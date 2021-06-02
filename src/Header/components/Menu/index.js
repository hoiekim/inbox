import React, { useContext } from "react";
import WriteIcon from "./components/WriteIcon";
import LogoutIcon from "./components/LogoutIcon";
import RefreshIcon from "./components/RefreshIcon";
import { Context } from "../../..";

const Menu = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div id="buttons">
      <div id="write" className="iconBox">
        <WriteIcon className="cursor" onClick={onClickWriter} />
      </div>
      <div id="refresh" className="iconBox">
        <RefreshIcon className="cursor" />
      </div>
      <div id="logout" className="iconBox">
        <LogoutIcon className="cursor" />
      </div>
    </div>
  );
};

export default Menu;
