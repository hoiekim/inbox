import { useContext } from "react";
import { Context, onKeyboardActivate } from "client";
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
    <div
      className="menu left cursor"
      role="button"
      tabIndex={0}
      aria-label="Toggle accounts panel"
      aria-expanded={isAccountsOpen}
      onClick={onClickHamburger}
      onKeyDown={onKeyboardActivate(onClickHamburger)}
    >
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
