import { useContext } from "react";
import { Context } from "client";
import HamburgerIcon from "./components/HamburgerIcon";

const LeftMenu = () => {
  const {
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen,
    newMailsTotal
  } = useContext(Context);

  const onClickHamburger = () => {
    if (isWriterOpen) {
      setIsWriterOpen(false);
      if (!isAccountsOpen) setIsAccountsOpen(true);
    } else setIsAccountsOpen(!isAccountsOpen);
  };

  return (
    <div className="menu left cursor" onClick={onClickHamburger}>
      <div id="hamburger" className="iconBox">
        <div>
          <HamburgerIcon />
          {newMailsTotal && !isAccountsOpen ? (
            <div className="numberBall" />
          ) : (
            <></>
          )}
        </div>
      </div>
    </div>
  );
};

export default LeftMenu;
