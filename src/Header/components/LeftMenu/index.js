import React, { useContext } from "react";

import HamburgerIcon from "./components/HamburgerIcon";
import { Context } from "../../..";

const LeftMenu = () => {
  const { isHamburgerMenuOpen, setIsHamburgerMenuOpen } = useContext(Context);

  const onClickHamburger = () => {
    setIsHamburgerMenuOpen(!isHamburgerMenuOpen);
  };

  return (
    <div className="menu">
      <div id="hamburger" className="iconBox">
        <HamburgerIcon className="cursor" onClick={onClickHamburger} />
      </div>
    </div>
  );
};

export default LeftMenu;
