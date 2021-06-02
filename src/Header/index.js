import React from "react";
import Menu from "./components/Menu";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

const Header = () => {
  return (
    <>
      <h1>{domainName} Mail</h1>
      <Menu />
    </>
  );
};

export default Header;
