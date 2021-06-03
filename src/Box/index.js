import React from "react";
import Writer from "./components/Writer";
import Accounts from "./components/Accounts";
import Mails from "./components/Mails";
import "./index.scss";

const Box = () => {
  return (
    <div className="container-wrap">
      <div id="container">
        <Writer />
        <Accounts />
        <Mails />
      </div>
    </div>
  );
};

export default Box;
