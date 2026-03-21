import { KeyboardEvent, useContext } from "react";
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
    <div
      className="menu left cursor"
      onClick={onClickHamburger}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClickHamburger();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={isAccountsOpen ? "Close account panel" : "Open account panel"}
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
