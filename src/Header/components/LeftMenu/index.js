import React, { useContext } from "react";

import HamburgerIcon from "./components/HamburgerIcon";
import { Context } from "../../..";

const LeftMenu = () => {
  const { isAccountsOpen, setIsAccountsOpen, isWriterOpen, setIsWriterOpen } =
    useContext(Context);

  const onClickHamburger = () => {
    if (isWriterOpen) {
      setIsWriterOpen(false);
      if (!isAccountsOpen) setIsAccountsOpen(true);
    } else setIsAccountsOpen(!isAccountsOpen);
  };

  return (
    <div className="menu left cursor" onClick={onClickHamburger}>
      <div id="hamburger" className="iconBox">
        <HamburgerIcon />
      </div>
    </div>
  );
};

export default LeftMenu;
