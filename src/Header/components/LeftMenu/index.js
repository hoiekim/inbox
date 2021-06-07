import React, { useContext } from "react";

import HamburgerIcon from "./components/HamburgerIcon";
import { Context } from "../../..";

const LeftMenu = () => {
  const { isAccountsOpen, setIsAccountsOpen } = useContext(Context);

  const onClickHamburger = () => {
    setIsAccountsOpen(!isAccountsOpen);
  };

  return (
    <div className="menu left">
      <div id="hamburger" className="iconBox">
        <HamburgerIcon className="cursor" onClick={onClickHamburger} />
      </div>
    </div>
  );
};

export default LeftMenu;
